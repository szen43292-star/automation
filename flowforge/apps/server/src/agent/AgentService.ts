import type { FastifyBaseLogger } from 'fastify';
import type { Agent, Prisma, PrismaClient, WhatsAppAccount } from '@prisma/client';
import type { AiProviders, ProviderId } from '../ai/providers';
import type { CallAgent, CallSummarizer } from '../calls/CallService';
import type { ExecutionService } from '../executions/ExecutionService';
import type { PushPublisher } from '../executions/types';
import { HttpError, badRequest } from '../lib/errors';
import type { WhatsAppService } from '../whatsapp/WhatsAppService';
import {
  DEFAULT_MODELS,
  DEFAULT_VOICES,
  LLM_PROVIDERS,
  readNotify,
  readTools,
  readVoice,
  type AgentInput,
  type AgentVoice,
  type LlmProvider,
} from './config';
import { runPipeline, type EngineContext } from './engine';
import { KnowledgeIndex, splitDocument } from './knowledge';
import { complete, createBrain, llmModel } from './llm';
import { runRealtime } from './realtime';
import { synthesize, transcribe } from './speech';
import { buildTools, runTool, type ToolContext } from './tools';

export interface AgentServiceDeps {
  prisma: PrismaClient;
  providers: AiProviders;
  whatsapp: WhatsAppService;
  executions: ExecutionService;
  push: PushPublisher;
  logger: FastifyBaseLogger;
  defaultTimezone: string;
}

type AgentRow = Agent & {
  documents?: Array<{
    id: string;
    title: string;
    content: string;
    createdAt: Date;
    updatedAt: Date;
  }>;
  accounts?: Array<{ id: string; displayPhoneNumber: string; name: string }>;
  _count?: { documents: number; calls: number };
};

export const toAgentDTO = (a: AgentRow) => ({
  id: a.id,
  name: a.name,
  instructions: a.instructions,
  greeting: a.greeting,
  languages: a.languages,
  engine: a.engine as 'realtime' | 'pipeline',
  voice: readVoice(a.voice),
  tools: readTools(a.tools),
  notify: readNotify(a.notify),
  createdAt: a.createdAt.toISOString(),
  updatedAt: a.updatedAt.toISOString(),
  ...(a.documents
    ? {
        documents: a.documents.map((d) => ({
          id: d.id,
          title: d.title,
          characters: d.content.length,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
      }
    : {}),
  ...(a.accounts ? { numbers: a.accounts } : {}),
  ...(a._count ? { documentCount: a._count.documents, callCount: a._count.calls } : {}),
});

const json = (value: unknown) => value as Prisma.InputJsonValue;

/** Providers an agent needs for calls. */
export function providersNeeded(engine: string, voice: AgentVoice): ProviderId[] {
  if (engine === 'realtime') return ['openai'];
  return [...new Set<ProviderId>([voice.stt.provider, voice.llm.provider, voice.tts.provider])];
}

/**
 * AI voice agents: personas with knowledge and tools that answer WhatsApp calls.
 */
export class AgentService {
  private readonly indexes = new Map<string, { version: string; index: KnowledgeIndex }>();

  constructor(private readonly deps: AgentServiceDeps) {}

  // ---- Agents -------------------------------------------------------------------------------------

  async list() {
    const rows = await this.deps.prisma.agent.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        accounts: { select: { id: true, displayPhoneNumber: true, name: true } },
        _count: { select: { documents: true, calls: true } },
      },
    });
    return rows.map(toAgentDTO);
  }

  private async row(id: string) {
    const row = await this.deps.prisma.agent.findUnique({
      where: { id },
      include: {
        documents: { orderBy: { createdAt: 'asc' } },
        accounts: { select: { id: true, displayPhoneNumber: true, name: true } },
      },
    });
    if (!row) throw new HttpError(404, 'Agent not found', 'NotFound');
    return row;
  }

  async get(id: string) {
    return toAgentDTO(await this.row(id));
  }

  private async checkWorkflowTools(input: AgentInput) {
    const names = new Set<string>();
    for (const tool of input.tools.workflows) {
      if (names.has(tool.name)) throw badRequest(`Two tools are called "${tool.name}"`);
      names.add(tool.name);
      const workflow = await this.deps.prisma.workflow.findUnique({
        where: { id: tool.workflowId },
      });
      if (!workflow) throw badRequest(`Tool "${tool.name}": the workflow does not exist`);
    }
  }

  async create(input: AgentInput, userId: string | null) {
    await this.checkWorkflowTools(input);
    const row = await this.deps.prisma.agent.create({
      data: {
        name: input.name,
        instructions: input.instructions,
        greeting: input.greeting,
        languages: input.languages,
        engine: input.engine,
        voice: json(input.voice),
        tools: json(input.tools),
        notify: json(input.notify),
        createdById: userId,
      },
    });
    return this.get(row.id);
  }

  async update(id: string, input: AgentInput) {
    await this.row(id);
    await this.checkWorkflowTools(input);
    await this.deps.prisma.agent.update({
      where: { id },
      data: {
        name: input.name,
        instructions: input.instructions,
        greeting: input.greeting,
        languages: input.languages,
        engine: input.engine,
        voice: json(input.voice),
        tools: json(input.tools),
        notify: json(input.notify),
      },
    });
    return this.get(id);
  }

  async remove(id: string) {
    await this.row(id);
    await this.deps.prisma.agent.delete({ where: { id } });
    this.indexes.delete(id);
  }

  /** Which agent answers calls to a number (call mode "AI agent"). */
  async assign(accountId: string, agentId: string | null) {
    await this.deps.whatsapp.row(accountId);
    if (agentId) await this.row(agentId);
    await this.deps.prisma.whatsAppAccount.update({ where: { id: accountId }, data: { agentId } });
  }

  /** The number's agent; with only one agent, that one. */
  async agentFor(account: WhatsAppAccount): Promise<Agent | null> {
    if (account.agentId) {
      const agent = await this.deps.prisma.agent.findUnique({ where: { id: account.agentId } });
      if (agent) return agent;
    }
    const agents = await this.deps.prisma.agent.findMany({ take: 2 });
    return agents.length === 1 ? agents[0]! : null;
  }

  async missingProviders(agent: Agent): Promise<ProviderId[]> {
    const configured = await this.deps.providers.configured();
    return providersNeeded(agent.engine, readVoice(agent.voice)).filter((p) => !configured.has(p));
  }

  async available(account: WhatsAppAccount, agentId?: string | null): Promise<boolean> {
    const agent = agentId
      ? await this.deps.prisma.agent.findUnique({ where: { id: agentId } })
      : await this.agentFor(account);
    return Boolean(agent) && (await this.missingProviders(agent!)).length === 0;
  }

  // ---- Knowledge ----------------------------------------------------------------------------------

  async addDocument(agentId: string, input: { title: string; content: string }) {
    await this.row(agentId);
    const doc = await this.deps.prisma.knowledgeDocument.create({
      data: { agentId, title: input.title, content: input.content },
    });
    this.indexes.delete(agentId);
    return { id: doc.id, title: doc.title, characters: doc.content.length };
  }

  async getDocument(agentId: string, documentId: string) {
    const doc = await this.deps.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, agentId },
    });
    if (!doc) throw new HttpError(404, 'Document not found', 'NotFound');
    return { id: doc.id, title: doc.title, content: doc.content };
  }

  async updateDocument(
    agentId: string,
    documentId: string,
    input: { title: string; content: string },
  ) {
    await this.getDocument(agentId, documentId);
    await this.deps.prisma.knowledgeDocument.update({ where: { id: documentId }, data: input });
    this.indexes.delete(agentId);
  }

  async removeDocument(agentId: string, documentId: string) {
    await this.deps.prisma.knowledgeDocument.deleteMany({ where: { id: documentId, agentId } });
    this.indexes.delete(agentId);
  }

  private async index(agentId: string): Promise<KnowledgeIndex> {
    const docs = await this.deps.prisma.knowledgeDocument.findMany({
      where: { agentId },
      select: { id: true, title: true, updatedAt: true },
    });
    const version = docs.map((d) => `${d.id}:${d.updatedAt.getTime()}`).join(',');
    const cached = this.indexes.get(agentId);
    if (cached?.version === version) return cached.index;
    const full = await this.deps.prisma.knowledgeDocument.findMany({ where: { agentId } });
    const index = new KnowledgeIndex(full.flatMap((d) => splitDocument(d.id, d.title, d.content)));
    this.indexes.set(agentId, { version, index });
    return index;
  }

  async search(agentId: string, query: string) {
    await this.row(agentId);
    return (await this.index(agentId)).search(query, 5);
  }

  // ---- Prompt -------------------------------------------------------------------------------------

  /** What the agent knows about the caller from earlier calls and chats. */
  async callerContext(
    accountId: string,
    contact: string,
    contactName: string | null,
    currentCallId?: string,
  ) {
    const [previous, lastCalls, messages] = await Promise.all([
      this.deps.prisma.call.count({
        where: { accountId, contact, ...(currentCallId ? { id: { not: currentCallId } } : {}) },
      }),
      this.deps.prisma.call.findMany({
        where: { accountId, contact, summary: { not: null } },
        orderBy: { startedAt: 'desc' },
        take: 3,
        select: { startedAt: true, summary: true },
      }),
      this.deps.prisma.whatsAppMessage.findMany({
        where: { accountId, contact, text: { not: null } },
        orderBy: { timestamp: 'desc' },
        take: 6,
        select: { direction: true, text: true, timestamp: true },
      }),
    ]);
    const lines = [`Name on WhatsApp: ${contactName ?? 'unknown'}; number: +${contact}.`];
    if (!previous && !messages.length) lines.push('This is a new caller - first contact.');
    else {
      lines.push(`Returning contact: ${previous} earlier call(s).`);
      for (const c of lastCalls)
        lines.push(`- Call on ${c.startedAt.toISOString().slice(0, 10)}: ${c.summary}`);
      if (messages.length) {
        lines.push('Recent WhatsApp messages (newest first):');
        for (const m of messages)
          lines.push(
            `- ${m.direction === 'inbound' ? 'Them' : 'Business'}: ${m.text!.slice(0, 200)}`,
          );
      }
      lines.push('Greet them as someone you know when it fits, and use this history.');
    }
    return lines.join('\n');
  }

  instructions(
    agent: Agent,
    context: {
      business: string;
      caller: string;
      timezone: string;
      testChat?: boolean;
      /** Outbound call: why we called. */
      purpose?: string | null;
    },
  ) {
    const tools = readTools(agent.tools);
    const now = new Intl.DateTimeFormat('en-GB', {
      timeZone: context.timezone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date());
    const rules = [
      context.testChat
        ? '- This is a text test chat that stands in for a phone call. Answer as you would speak on the call.'
        : '- You are on a live WhatsApp voice call. Your words are spoken aloud.',
      '- Keep every reply short: one to three sentences in natural spoken language. No lists, markdown, emojis or symbols; say numbers and prices the way people speak them.',
      `- You speak ${agent.languages.join(', ')}. Reply in the language the caller uses; if they mix Hindi and English (Hinglish), reply in Hinglish.`,
      context.purpose !== undefined && context.purpose !== null
        ? '- You called the customer (they did not call you). Greet them by name if you know it, say who you are and why you are calling. If it is a bad time, offer to call back later and end the call politely.'
        : `- You already greeted the caller with: "${agent.greeting}"`,
      '- Never invent prices, dates, availability or policies.',
    ];
    if (tools.knowledge)
      rules.push('- Look up facts about the business with search_knowledge before answering them.');
    if (tools.transfer)
      rules.push(
        '- When the caller asks for a person, or you cannot help, say you are connecting them and call transfer_to_human.',
      );
    if (tools.whatsappMessage)
      rules.push(
        '- Send links, addresses and confirmations with send_whatsapp_message instead of reading them out.',
      );
    if (tools.endCall)
      rules.push('- When the conversation is finished, say a short goodbye and call end_call.');
    return [
      agent.instructions.trim() ||
        'You are a friendly, helpful receptionist answering phone calls for this business.',
      `\n# How to talk\n${rules.join('\n')}`,
      `\n# Business\n${context.business}`,
      `\n# Now\n${now} (${context.timezone})`,
      `\n# The caller\n${context.caller}`,
      ...(context.purpose !== undefined && context.purpose !== null
        ? [
            `\n# Why you are calling\n${context.purpose || 'A friendly follow-up with the customer.'}`,
          ]
        : []),
    ].join('\n');
  }

  /** LLM for text (test chats and summaries): the agent's own, or any configured one. */
  private async textModel(agent: Agent): Promise<{ provider: LlmProvider; model: string }> {
    const voice = readVoice(agent.voice);
    const configured = await this.deps.providers.configured();
    if (configured.has(voice.llm.provider)) return voice.llm;
    const provider = LLM_PROVIDERS.find((p) => configured.has(p));
    if (!provider)
      throw badRequest('Add an Anthropic, OpenAI or Gemini key in Settings → AI providers first');
    return { provider, model: '' };
  }

  // ---- Calls --------------------------------------------------------------------------------------

  readonly runCall: CallAgent = async (call) => {
    const agent = call.outbound?.agentId
      ? await this.deps.prisma.agent.findUnique({ where: { id: call.outbound.agentId } })
      : await this.agentFor(call.account);
    if (!agent) throw new Error('No AI agent is set up for this number');
    await this.deps.prisma.call.update({ where: { id: call.callId }, data: { agentId: agent.id } });
    const voice = readVoice(agent.voice);
    const timezone = call.settings.businessHours.timezone || this.deps.defaultTimezone;
    const instructions = this.instructions(agent, {
      business: `${call.account.verifiedName ?? call.account.name} (WhatsApp ${call.account.displayPhoneNumber})`,
      caller: await this.callerContext(
        call.account.id,
        call.contact,
        call.contactName,
        call.callId,
      ),
      timezone,
      purpose: call.outbound ? call.outbound.purpose : null,
    });
    const index = await this.index(agent.id);
    let endReason: string | null = null;
    const toolContext: ToolContext = {
      searchKnowledge: (query) => index.search(query, 3),
      transfer: () => call.transfer(),
      endCall: (reason) => {
        endReason = reason;
      },
      sendWhatsApp: async (text) => {
        await this.deps.whatsapp.send(call.account.id, call.contact, {
          type: 'text',
          text: { body: text },
        });
      },
      runWorkflow: (tool, input) =>
        this.deps.executions.runWorkflowTool(tool.workflowId, {
          ...input,
          caller: { number: call.contact, name: call.contactName },
          callId: call.callId,
          tool: tool.name,
        }),
    };
    const ctx: EngineContext = {
      session: call.session,
      signal: call.signal,
      greeting: call.outbound ? null : agent.greeting || call.settings.greetingText,
      opening: call.outbound
        ? '(The customer just picked up your call. Start the conversation now.)'
        : null,
      tools: buildTools(readTools(agent.tools), toolContext),
      transcript: call.transcript,
      endRequested: () => endReason !== null,
      hangup: call.hangup,
      logger: this.deps.logger,
    };
    if (agent.engine === 'realtime') {
      await runRealtime(ctx, await this.deps.providers.require('openai'), {
        model: voice.realtime.model || DEFAULT_MODELS.realtime,
        voice: voice.realtime.voice || DEFAULT_VOICES.realtime,
        instructions,
        language: voice.language,
      });
      return;
    }
    const brain = await createBrain(this.deps.providers, voice.llm, instructions, ctx.tools);
    await runPipeline(ctx, brain, {
      transcribe: (samples, signal) => transcribe(this.deps.providers, voice, samples, signal),
      synthesize: (text, signal) => synthesize(this.deps.providers, voice, text, signal),
    });
  };

  /** After a call: a short summary for the call log, workflows and the owner's WhatsApp. */
  readonly summarizeCall: CallSummarizer = async (call) => {
    const row = await this.deps.prisma.call.findUnique({
      where: { id: call.callId },
      select: { agentId: true },
    });
    const agent =
      (row?.agentId
        ? await this.deps.prisma.agent.findUnique({ where: { id: row.agentId } })
        : null) ?? (await this.agentFor(call.account));
    if (!agent) return null;
    const notify = readNotify(agent.notify);
    if (!notify.summary && !notify.whatsappTo) return null;
    const transcript = call.transcript
      .map((line) => `${line.role === 'agent' ? 'Agent' : 'Caller'}: ${line.text}`)
      .join('\n');
    const summary = await complete(
      this.deps.providers,
      await this.textModel(agent),
      'You write call notes for a small business owner. Write 2-4 short sentences in English: ' +
        'who called, what they wanted, what was promised or booked, and any follow-up the team ' +
        'must do. Plain text, no headings.',
      `Call from ${call.contactName ?? 'unknown'} (+${call.contact}).\n\nTranscript:\n${transcript}`,
    );
    if (summary && notify.whatsappTo) {
      const note = `📞 Call from ${call.contactName ?? ''} +${call.contact}\n\n${summary}`.trim();
      await this.deps.whatsapp
        .send(call.account.id, notify.whatsappTo, { type: 'text', text: { body: note } })
        .catch((error: Error) =>
          this.deps.logger.warn(
            { err: error },
            'Could not send the call summary on WhatsApp (the owner may need to message the number first - 24-hour window)',
          ),
        );
    }
    if (summary) {
      this.deps.push.publish(['whatsapp'], {
        type: 'callSummary',
        data: {
          callId: call.callId,
          summary,
          contact: call.contact,
          contactName: call.contactName,
        },
      });
    }
    return notify.summary ? summary || null : null;
  };

  // ---- Test chat ----------------------------------------------------------------------------------

  /**
   * Chat with the agent in text, as if on a call: same persona, knowledge and workflow tools.
   * Transfer, hang-up and WhatsApp messages are only reported, not done.
   */
  async testChat(
    agentId: string,
    history: Array<{ role: 'caller' | 'agent'; text: string }>,
    user: { name: string },
  ) {
    const agent = await this.row(agentId);
    if (!history.length || history.at(-1)!.role !== 'caller')
      throw badRequest('The last message must be from the caller');
    const index = await this.index(agent.id);
    const actions: Array<{ tool: string; input: unknown; output: string }> = [];
    const toolContext: ToolContext = {
      searchKnowledge: (query) => index.search(query, 3),
      transfer: async () => false,
      endCall: () => undefined,
      sendWhatsApp: async () => undefined,
      runWorkflow: (tool, input) =>
        this.deps.executions.runWorkflowTool(tool.workflowId, {
          ...input,
          caller: { number: '0000000000', name: user.name },
          callId: 'test-chat',
          tool: tool.name,
        }),
    };
    const tools = buildTools(readTools(agent.tools), toolContext);
    const instructions = this.instructions(agent, {
      business: 'Test chat in AutoForge',
      caller: `Name: ${user.name}. This is a test conversation by the business itself.`,
      timezone: this.deps.defaultTimezone,
      testChat: true,
    });
    const model = await this.textModel(agent);
    const brain = await createBrain(this.deps.providers, model, instructions, tools);
    for (const message of history) {
      if (message.role === 'caller') brain.addUser(message.text);
      else brain.addAssistant(message.text);
    }
    const replies: string[] = [];
    for (let step = 0; step < 5; step++) {
      const turn = await brain.generate(() => undefined);
      if (turn.text.trim()) replies.push(turn.text.trim());
      if (!turn.toolCalls.length) break;
      const results = [];
      for (const call of turn.toolCalls) {
        const result = await runTool(tools, call.name, call.input);
        actions.push({ tool: call.name, input: call.input, output: result.output });
        results.push({ id: call.id, ...result });
      }
      brain.addToolResults(results);
    }
    return {
      reply: replies.join(' '),
      actions,
      model: `${model.provider}/${await llmModel(this.deps.providers, model.provider, model.model)}`,
    };
  }
}
