import {
  NodeApiError,
  NodeOperationError,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
} from '@flowforge/workflow';
import { errorItem } from '../shared/helpers';

const CREDENTIAL = 'googlePalmApi';
const DEFAULT_HOST = 'https://generativelanguage.googleapis.com';
/** Tried in order when the model is left empty or the key cannot use the one asked for. */
const PREFERRED_MODELS = [
  'gemini-2.5-flash',
  'gemini-flash-latest',
  'gemini-2.5-pro',
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash-lite',
];
const NOT_CHAT = /embed|aqa|imagen|veo|image|tts|audio|live|vision|learnlm|computer-use|robotics/i;

type Schema = IDataObject;

/** A Gemini response schema from an example value: {"title":"","tags":[""]} etc. */
export function schemaFromExample(example: unknown): Schema {
  if (Array.isArray(example))
    return {
      type: 'ARRAY',
      items: example.length ? schemaFromExample(example[0]) : { type: 'STRING' },
    };
  if (example === null || example === undefined) return { type: 'STRING', nullable: true };
  switch (typeof example) {
    case 'number':
      return { type: 'NUMBER' };
    case 'boolean':
      return { type: 'BOOLEAN' };
    case 'object': {
      const keys = Object.keys(example as object);
      return {
        type: 'OBJECT',
        properties: Object.fromEntries(
          keys.map((key) => [key, schemaFromExample((example as IDataObject)[key])]),
        ),
        required: keys,
        propertyOrdering: keys,
      };
    }
    default:
      return { type: 'STRING' };
  }
}

/** Keys the example has that the answer lacks (top level and nested objects). */
export function missingKeys(example: unknown, value: unknown, path = ''): string[] {
  if (!example || typeof example !== 'object' || Array.isArray(example)) return [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [path || '(object)'];
  return Object.keys(example).flatMap((key) =>
    key in (value as IDataObject)
      ? missingKeys(
          (example as IDataObject)[key],
          (value as IDataObject)[key],
          path ? `${path}.${key}` : key,
        )
      : [path ? `${path}.${key}` : key],
  );
}

/** The JSON in a model answer, also when it is wrapped in a ```json fence or extra words. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidates = [trimmed, fenced];
  const start = trimmed.search(/[[{]/);
  const end = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'));
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('The answer is not valid JSON');
}

/** The model to use: the one asked for when the key has it, else the best available one. */
export function pickGeminiModel(available: string[] | null, requested: string): string {
  const wanted = requested.trim().replace(/^models\//, '');
  if (!available?.length) return wanted || PREFERRED_MODELS[0]!;
  if (wanted && available.includes(wanted)) return wanted;
  for (const model of PREFERRED_MODELS) if (available.includes(model)) return model;
  const usable = available.filter((m) => m.startsWith('gemini') && !NOT_CHAT.test(m));
  return usable.sort().reverse()[0] ?? (wanted || PREFERRED_MODELS[0]!);
}

function answerText(body: IDataObject): { text: string; finishReason?: string } {
  const candidate = (body.candidates as IDataObject[] | undefined)?.[0];
  const parts = ((candidate?.content as IDataObject | undefined)?.parts as IDataObject[]) ?? [];
  return {
    text: parts
      .filter((p) => !p.thought)
      .map((p) => String(p.text ?? ''))
      .join(''),
    finishReason: candidate?.finishReason as string | undefined,
  };
}

export const LlmChain: INodeType = {
  description: {
    name: 'flowforge.chainLlm',
    displayName: 'Basic LLM Chain',
    icon: 'sparkles',
    iconColor: '#7c3aed',
    group: ['ai'],
    version: 1,
    description: 'Ask a chat model (Google Gemini) and get its answer, optionally as JSON',
    subtitle: '={{ $parameter.model || "Gemini (automatic)" }}',
    defaults: { name: 'Basic LLM Chain' },
    inputs: [{ type: 'main' }],
    outputs: [{ type: 'main' }],
    keywords: ['llm', 'ai', 'gemini', 'google', 'prompt', 'chat', 'gpt', 'json', 'chain'],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Chat Model',
        name: 'modelProvider',
        type: 'options',
        default: 'googleGemini',
        noDataExpression: true,
        options: [{ name: 'Google Gemini Chat Model', value: 'googleGemini' }],
      },
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: '',
        placeholder: 'Automatic (e.g. gemini-2.5-flash)',
        description:
          'Leave empty to use the best model your API key can use. A model the key cannot use is replaced automatically.',
      },
      {
        displayName: 'Prompt',
        name: 'text',
        type: 'string',
        default: '',
        required: true,
        typeOptions: { rows: 10 },
      },
      {
        displayName: 'Require Specific Output Format',
        name: 'hasOutputParser',
        type: 'boolean',
        default: false,
        description:
          'Whether the answer must be JSON shaped like the example below (Structured Output Parser). It is then in "output"; otherwise the answer is in "text".',
      },
      {
        displayName: 'JSON Example',
        name: 'jsonSchemaExample',
        type: 'json',
        default: '{\n  "answer": ""\n}',
        typeOptions: { rows: 6, editor: 'json' },
        displayOptions: { show: { hasOutputParser: [true] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        default: {},
        placeholder: 'Add option',
        options: [
          {
            displayName: 'System Message',
            name: 'systemMessage',
            type: 'string',
            default: '',
            typeOptions: { rows: 4 },
          },
          {
            displayName: 'Temperature',
            name: 'temperature',
            type: 'number',
            default: 0.7,
            typeOptions: { minValue: 0, maxValue: 2 },
          },
          {
            displayName: 'Max Output Tokens',
            name: 'maxOutputTokens',
            type: 'number',
            default: 8192,
            typeOptions: { minValue: 1 },
          },
        ],
      },
    ],
  },

  async execute(this: IExecuteFunctions) {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    const credentials = await this.getCredentials<IDataObject>(CREDENTIAL);
    const host = String(credentials.host || DEFAULT_HOST).replace(/\/+$/, '');

    let models: string[] | null | undefined;
    const availableModels = async () => {
      if (models !== undefined) return models;
      try {
        const response = await this.helpers.httpRequestWithAuthentication(CREDENTIAL, {
          url: `${host}/v1beta/models`,
          method: 'GET',
          qs: { pageSize: 1000 },
          timeout: 30_000,
          responseType: 'json',
        });
        const list = (response.body as { models?: IDataObject[] } | null)?.models;
        models =
          response.statusCode < 400 && Array.isArray(list)
            ? list
                .filter((m) =>
                  (
                    (m.supportedGenerationMethods as string[] | undefined) ?? ['generateContent']
                  ).includes('generateContent'),
                )
                .map((m) => String(m.name ?? '').replace(/^models\//, ''))
                .filter(Boolean)
            : null;
      } catch {
        models = null;
      }
      return models;
    };

    for (let i = 0; i < items.length; i++) {
      try {
        const prompt = String(this.getNodeParameter('text', i, '') ?? '');
        if (!prompt.trim())
          throw new NodeOperationError(this.getNode(), 'The prompt is empty', { itemIndex: i });
        const options = this.getNodeParameter<IDataObject>('options', i, {});
        const structured = this.getNodeParameter<boolean>('hasOutputParser', i, false);
        let example: unknown;
        if (structured) {
          const raw = this.getNodeParameter<unknown>('jsonSchemaExample', i, '{}');
          try {
            example = typeof raw === 'string' ? JSON.parse(raw) : raw;
          } catch (error) {
            throw new NodeOperationError(this.getNode(), 'The JSON example is not valid JSON', {
              itemIndex: i,
              description: (error as Error).message,
            });
          }
        }
        const model = pickGeminiModel(
          await availableModels(),
          String(this.getNodeParameter('model', i, '') ?? ''),
        );

        const ask = async (text: string) => {
          const response = await this.helpers.httpRequestWithAuthentication(CREDENTIAL, {
            url: `${host}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            method: 'POST',
            timeout: 300_000,
            responseType: 'json',
            body: {
              contents: [{ role: 'user', parts: [{ text }] }],
              ...(options.systemMessage
                ? { systemInstruction: { parts: [{ text: String(options.systemMessage) }] } }
                : {}),
              generationConfig: {
                temperature: Number(options.temperature ?? 0.7),
                maxOutputTokens: Number(options.maxOutputTokens ?? 8192),
                ...(structured
                  ? {
                      responseMimeType: 'application/json',
                      responseSchema: schemaFromExample(example),
                    }
                  : {}),
              },
            },
          });
          const body = (response.body ?? {}) as IDataObject;
          if (response.statusCode >= 400) {
            const message = (body.error as IDataObject | undefined)?.message;
            throw new NodeApiError(
              this.getNode(),
              response.statusCode === 429
                ? `Gemini rate limit or quota reached (${model}): ${String(message ?? '')}`
                : `Gemini (${model}): ${String(message ?? `HTTP ${response.statusCode}`)}`,
              { httpCode: response.statusCode, responseBody: body, itemIndex: i },
            );
          }
          const blocked = (body.promptFeedback as IDataObject | undefined)?.blockReason;
          if (blocked)
            throw new NodeOperationError(
              this.getNode(),
              `Gemini refused the prompt (${String(blocked)})`,
              {
                itemIndex: i,
              },
            );
          return answerText(body);
        };

        let answer = await ask(prompt);
        if (!structured) {
          output.push({ json: { text: answer.text }, pairedItem: { item: i } });
          continue;
        }
        let parsed: unknown;
        let problem = '';
        // One more try when the answer does not fit the format.
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            parsed = extractJson(answer.text);
            const missing = missingKeys(example, parsed);
            if (!missing.length) {
              problem = '';
              break;
            }
            problem = `missing ${missing.join(', ')}`;
          } catch (error) {
            problem =
              answer.finishReason === 'MAX_TOKENS'
                ? 'the answer was cut off (raise Max Output Tokens)'
                : (error as Error).message;
          }
          if (attempt === 0)
            answer = await ask(
              `${prompt}\n\nAnswer with JSON only, exactly in this shape:\n${JSON.stringify(example)}`,
            );
        }
        if (problem)
          throw new NodeOperationError(
            this.getNode(),
            `The model's answer does not match the output format: ${problem}`,
            { itemIndex: i, description: answer.text.slice(0, 500) },
          );
        output.push({ json: { output: parsed as IDataObject }, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          output.push(errorItem(this, error, i, items[i]));
          continue;
        }
        throw error;
      }
    }
    return [output];
  },
};
