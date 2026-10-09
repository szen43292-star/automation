import type { AgentTools, WorkflowTool } from './config';
import type { SearchHit } from './knowledge';

/** A tool the agent can call. Every parameter is a required string (works with strict schemas). */
export interface AgentTool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, { type: 'string'; description: string }>;
    required: string[];
    additionalProperties: false;
  };
  run(input: Record<string, string>): Promise<string>;
}

export interface ToolContext {
  searchKnowledge(query: string): SearchHit[];
  /** Ring a person in the app; resolves true when someone picked up. */
  transfer(reason: string): Promise<boolean>;
  /** End the call once the agent's goodbye has been spoken. */
  endCall(reason: string): void;
  sendWhatsApp(text: string): Promise<void>;
  runWorkflow(tool: WorkflowTool, input: Record<string, string>): Promise<unknown>;
}

const schema = (properties: Record<string, string>): AgentTool['parameters'] => ({
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(properties).map(([name, description]) => [
      name,
      { type: 'string', description },
    ]),
  ),
  required: Object.keys(properties),
  additionalProperties: false,
});

const MAX_OUTPUT = 4_000;
const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}… (shortened)` : text;

export function buildTools(config: AgentTools, ctx: ToolContext): AgentTool[] {
  const tools: AgentTool[] = [];
  if (config.knowledge) {
    tools.push({
      name: 'search_knowledge',
      description:
        "Search the business's knowledge (prices, services, opening hours, policies, FAQs). " +
        'Use it before answering any factual question about the business.',
      parameters: schema({ query: 'What to look up, in a few keywords (any language).' }),
      run: async ({ query }) => {
        const hits = ctx.searchKnowledge(query!);
        if (!hits.length) return 'Nothing found in the knowledge base for this.';
        return clip(hits.map((h) => `[${h.title}]\n${h.text}`).join('\n\n'));
      },
    });
  }
  if (config.transfer) {
    tools.push({
      name: 'transfer_to_human',
      description:
        'Connect the caller to a person on the team. Tell the caller you are connecting them ' +
        'before you call this. Use it when they ask for a person or you cannot help.',
      parameters: schema({ reason: 'Why the caller needs a person, in one sentence.' }),
      run: async ({ reason }) =>
        (await ctx.transfer(reason!))
          ? 'A person picked up and is now talking to the caller. Do not say anything more.'
          : 'Nobody on the team is available right now. Apologise, offer to take a message, and ' +
            'tell the caller the team will get back to them.',
    });
  }
  if (config.endCall) {
    tools.push({
      name: 'end_call',
      description:
        'Hang up after your next sentence. Call it only when the conversation is finished and ' +
        'you have said goodbye (or the caller is abusive).',
      parameters: schema({ reason: 'Why the call is ending, in a few words.' }),
      run: async ({ reason }) => {
        ctx.endCall(reason!);
        return 'The call will end after you finish speaking. Say a short goodbye if you have not.';
      },
    });
  }
  if (config.whatsappMessage) {
    tools.push({
      name: 'send_whatsapp_message',
      description:
        'Send the caller a WhatsApp text message during the call - for links, addresses, ' +
        'booking confirmations or anything easier to read than to hear.',
      parameters: schema({ text: 'The message to send. Plain text, may include links.' }),
      run: async ({ text }) => {
        await ctx.sendWhatsApp(text!);
        return 'Sent. Tell the caller they got a WhatsApp message.';
      },
    });
  }
  for (const workflow of config.workflows) {
    tools.push({
      name: workflow.name,
      description: workflow.description,
      parameters: schema(
        Object.fromEntries(
          workflow.parameters.map((p) => [p.name, p.description || p.name.replace(/_/g, ' ')]),
        ),
      ),
      run: async (input) => {
        const result = await ctx.runWorkflow(workflow, input);
        return clip(typeof result === 'string' ? result : JSON.stringify(result ?? 'Done.'));
      },
    });
  }
  return tools;
}

/** Check a tool call's arguments against the tool's schema (model output is untrusted). */
export function checkInput(
  tool: AgentTool,
  input: unknown,
): { ok: true; value: Record<string, string> } | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { ok: false, error: 'Arguments must be a JSON object.' };
  const value: Record<string, string> = {};
  for (const name of tool.parameters.required) {
    const v = (input as Record<string, unknown>)[name];
    if (typeof v !== 'string') return { ok: false, error: `"${name}" must be a string.` };
    value[name] = v;
  }
  return { ok: true, value };
}

/** Run a tool call: unknown tools and bad arguments become error results the model can fix. */
export async function runTool(
  tools: AgentTool[],
  name: string,
  input: unknown,
): Promise<{ output: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { output: `There is no tool called "${name}".`, isError: true };
  const checked = checkInput(tool, input);
  if (!checked.ok) return { output: `Invalid arguments: ${checked.error}`, isError: true };
  try {
    return { output: await tool.run(checked.value), isError: false };
  } catch (error) {
    return { output: `The tool failed: ${(error as Error).message}`, isError: true };
  }
}
