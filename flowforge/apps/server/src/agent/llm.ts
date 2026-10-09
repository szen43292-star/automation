import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlockParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiProviders, ProviderAccess } from '../ai/providers';
import { DEFAULT_MODELS, type LlmProvider } from './config';
import type { AgentTool } from './tools';

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface BrainTurn {
  text: string;
  toolCalls: ToolCall[];
  /** refusal: the model declined; the reply is a short apology instead. */
  stop: 'end' | 'tools' | 'refusal' | 'max_tokens';
}

/**
 * The agent's language model with its own conversation history (in the provider's native format,
 * so e.g. Claude's thinking blocks are passed back unchanged).
 */
export interface Brain {
  addUser(text: string): void;
  /** Earlier agent reply (test chats replay their history). */
  addAssistant(text: string): void;
  addToolResults(results: Array<{ id: string; output: string; isError?: boolean }>): void;
  /** Generate the next reply; text streams through `onText`. Rejects when aborted. */
  generate(onText: (delta: string) => void, signal?: AbortSignal): Promise<BrainTurn>;
}

const REFUSAL_REPLY = "Sorry, I can't help with that on this call.";
const CANCELLED = 'Cancelled: the caller started talking before this finished.';

/** Turn provider errors into messages the owner can act on. */
export function describeAiError(provider: string, error: unknown): Error {
  if (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError
  )
    return new Error(`${provider} rejected the API key - check it in Settings → AI providers`);
  if (error instanceof Anthropic.RateLimitError)
    return new Error(`${provider} rate limit reached - try again in a moment`);
  if (error instanceof Anthropic.NotFoundError)
    return new Error(`${provider}: model not found - check the agent's model name`);
  if (error instanceof Anthropic.APIError) return new Error(`${provider}: ${error.message}`);
  return error instanceof Error ? error : new Error(String(error));
}

const isAbort = (error: unknown, signal?: AbortSignal) =>
  signal?.aborted ||
  error instanceof Anthropic.APIUserAbortError ||
  (error as Error)?.name === 'AbortError';

// ---- Claude ---------------------------------------------------------------------------------------

/** Request options for current Claude models: low effort keeps voice replies fast. */
function claudeOptions(model: string) {
  if (!/^claude-(opus|sonnet|fable)-5/.test(model)) return {};
  return {
    output_config: { effort: 'low' as const },
    // A declined request is retried server-side on Anthropic's recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  };
}

export class ClaudeBrain implements Brain {
  private readonly client: Anthropic;
  private readonly messages: BetaMessageParam[] = [];
  /** tool_use ids still waiting for a result. */
  private pending: string[] = [];

  constructor(
    access: ProviderAccess,
    private readonly model: string,
    private readonly system: string,
    private readonly tools: AgentTool[],
  ) {
    this.client = new Anthropic({ apiKey: access.apiKey, baseURL: access.baseUrl, maxRetries: 1 });
  }

  private pushUserBlocks(blocks: BetaContentBlockParam[]) {
    const last = this.messages.at(-1);
    if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(...blocks);
    else this.messages.push({ role: 'user', content: blocks });
  }

  private cancelPending(): BetaToolResultBlockParam[] {
    const results = this.pending.map((id): BetaToolResultBlockParam => ({
      type: 'tool_result',
      tool_use_id: id,
      content: CANCELLED,
      is_error: true,
    }));
    this.pending = [];
    return results;
  }

  addUser(text: string) {
    this.pushUserBlocks([...this.cancelPending(), { type: 'text', text }]);
  }

  addAssistant(text: string) {
    if (!this.messages.length) return; // the conversation has to start with the caller
    this.messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
  }

  addToolResults(results: Array<{ id: string; output: string; isError?: boolean }>) {
    const answered = new Set(results.map((r) => r.id));
    this.pending = this.pending.filter((id) => !answered.has(id));
    this.pushUserBlocks([
      ...results.map((r): BetaToolResultBlockParam => ({
        type: 'tool_result',
        tool_use_id: r.id,
        content: r.output,
        ...(r.isError ? { is_error: true } : {}),
      })),
      ...this.cancelPending(),
    ]);
  }

  async generate(onText: (delta: string) => void, signal?: AbortSignal): Promise<BrainTurn> {
    let streamed = '';
    try {
      const stream = this.client.beta.messages.stream(
        {
          model: this.model,
          max_tokens: 2048,
          system: this.system,
          messages: this.messages,
          ...(this.tools.length
            ? {
                tools: this.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.parameters,
                  strict: true,
                  eager_input_streaming: true,
                })),
              }
            : {}),
          ...claudeOptions(this.model),
        },
        { signal },
      );
      stream.on('text', (delta) => {
        streamed += delta;
        onText(delta);
      });
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') {
        // Partial output of a declined turn is discarded.
        this.messages.push({ role: 'assistant', content: [{ type: 'text', text: REFUSAL_REPLY }] });
        return { text: REFUSAL_REPLY, toolCalls: [], stop: 'refusal' };
      }
      this.messages.push({
        role: 'assistant',
        content: message.content as BetaContentBlockParam[],
      });
      const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      const toolCalls = message.content.flatMap((b) =>
        b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
      );
      this.pending = toolCalls.map((c) => c.id);
      if (message.stop_reason === 'max_tokens') {
        // A cut-off tool call may have incomplete arguments: never run it.
        if (toolCalls.length) this.addToolResults([]);
        return { text, toolCalls: [], stop: 'max_tokens' };
      }
      return { text, toolCalls, stop: toolCalls.length ? 'tools' : 'end' };
    } catch (error) {
      if (isAbort(error, signal)) {
        if (streamed.trim())
          this.messages.push({ role: 'assistant', content: [{ type: 'text', text: streamed }] });
        throw new DOMException('Aborted', 'AbortError');
      }
      throw describeAiError('Anthropic', error);
    }
  }
}

// ---- OpenAI-compatible (OpenAI, Gemini) -------------------------------------------------------------

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Server-sent events of a streaming HTTP response, as parsed JSON objects. */
export async function* readSse(response: Response): AsyncGenerator<any> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // keep-alive or partial garbage
      }
    }
  }
}

async function httpError(provider: string, response: Response): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as {
      error?: { message?: string } | string;
      message?: string;
    };
    detail =
      typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '');
  } catch {
    detail = response.statusText;
  }
  if (response.status === 401 || response.status === 403)
    return new Error(`${provider} rejected the API key - check it in Settings → AI providers`);
  if (response.status === 429) return new Error(`${provider} rate limit reached: ${detail}`);
  return new Error(`${provider} error ${response.status}: ${detail}`);
}
export { httpError };

export class ChatCompletionsBrain implements Brain {
  private readonly messages: ChatMessage[];
  private pending: string[] = [];

  constructor(
    private readonly provider: 'OpenAI' | 'Gemini',
    private readonly access: ProviderAccess,
    private readonly model: string,
    system: string,
    private readonly tools: AgentTool[],
  ) {
    this.messages = [{ role: 'system', content: system }];
  }

  private cancelPending() {
    for (const id of this.pending)
      this.messages.push({ role: 'tool', tool_call_id: id, content: CANCELLED });
    this.pending = [];
  }

  addUser(text: string) {
    this.cancelPending();
    this.messages.push({ role: 'user', content: text });
  }

  addAssistant(text: string) {
    this.messages.push({ role: 'assistant', content: text });
  }

  addToolResults(results: Array<{ id: string; output: string; isError?: boolean }>) {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: r.output });
      this.pending = this.pending.filter((id) => id !== r.id);
    }
    this.cancelPending();
  }

  async generate(onText: (delta: string) => void, signal?: AbortSignal): Promise<BrainTurn> {
    let text = '';
    const calls: Array<{ id: string; name: string; arguments: string }> = [];
    let finish = '';
    try {
      const response = await fetch(`${this.access.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.access.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: this.messages,
          stream: true,
          max_tokens: 1024,
          ...(this.tools.length
            ? {
                tools: this.tools.map((t) => ({
                  type: 'function',
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                    ...(this.provider === 'OpenAI' ? { strict: true } : {}),
                  },
                })),
              }
            : {}),
        }),
        signal,
      });
      if (!response.ok) throw await httpError(this.provider, response);
      for await (const chunk of readSse(response)) {
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          onText(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? calls.length;
          calls[index] ??= { id: '', name: '', arguments: '' };
          if (call.id) calls[index].id = call.id;
          if (call.function?.name) calls[index].name += call.function.name;
          if (call.function?.arguments) calls[index].arguments += call.function.arguments;
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      if (isAbort(error, signal)) {
        if (text.trim()) this.messages.push({ role: 'assistant', content: text });
        throw new DOMException('Aborted', 'AbortError');
      }
      throw error;
    }
    const complete = calls.filter((c) => c.name);
    this.messages.push({
      role: 'assistant',
      content: text || null,
      ...(complete.length
        ? {
            tool_calls: complete.map((c, i) => ({
              id: c.id || `call_${i}`,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    });
    const toolCalls = complete.map((c, i) => {
      let input: unknown = null;
      try {
        input = JSON.parse(c.arguments || '{}');
      } catch {
        input = null; // reported back to the model as invalid arguments
      }
      return { id: c.id || `call_${i}`, name: c.name, input };
    });
    this.pending = toolCalls.map((c) => c.id);
    if (finish === 'length') {
      if (toolCalls.length) this.addToolResults([]);
      return { text, toolCalls: [], stop: 'max_tokens' };
    }
    return { text, toolCalls, stop: toolCalls.length ? 'tools' : 'end' };
  }
}

// ---- Factory and one-shot completions ---------------------------------------------------------------

export const llmModel = (provider: LlmProvider, model: string) =>
  model.trim() || DEFAULT_MODELS.llm[provider];

export async function createBrain(
  providers: AiProviders,
  config: { provider: LlmProvider; model: string },
  system: string,
  tools: AgentTool[],
): Promise<Brain> {
  const model = llmModel(config.provider, config.model);
  if (config.provider === 'anthropic')
    return new ClaudeBrain(await providers.require('anthropic'), model, system, tools);
  if (config.provider === 'gemini')
    return new ChatCompletionsBrain(
      'Gemini',
      await providers.require('gemini'),
      model,
      system,
      tools,
    );
  return new ChatCompletionsBrain(
    'OpenAI',
    await providers.require('openai'),
    model,
    system,
    tools,
  );
}

/** A single answer without tools (call summaries). */
export async function complete(
  providers: AiProviders,
  config: { provider: LlmProvider; model: string },
  system: string,
  prompt: string,
): Promise<string> {
  const model = llmModel(config.provider, config.model);
  if (config.provider === 'anthropic') {
    const access = await providers.require('anthropic');
    const client = new Anthropic({ apiKey: access.apiKey, baseURL: access.baseUrl, maxRetries: 2 });
    try {
      const message = await client.beta.messages.create({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: 'user', content: prompt }],
        ...claudeOptions(model),
      });
      if (message.stop_reason === 'refusal') return '';
      return message.content
        .flatMap((b) => (b.type === 'text' ? [b.text] : []))
        .join('')
        .trim();
    } catch (error) {
      throw describeAiError('Anthropic', error);
    }
  }
  const name = config.provider === 'gemini' ? 'Gemini' : 'OpenAI';
  const access = await providers.require(config.provider);
  const response = await fetch(`${access.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!response.ok) throw await httpError(name, response);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return body.choices?.[0]?.message?.content?.trim() ?? '';
}
