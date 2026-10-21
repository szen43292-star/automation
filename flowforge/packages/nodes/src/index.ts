import type { INodeType, INodeTypeDescription, INodeTypes } from '@flowforge/workflow';
import { Aggregate } from './nodes/Aggregate';
import { Code } from './nodes/Code';
import { DateTimeNode } from './nodes/DateTime';
import { EditFields } from './nodes/EditFields';
import { Filter } from './nodes/Filter';
import { Gmail } from './nodes/Gmail';
import { GoogleSheets } from './nodes/GoogleSheets';
import { HttpRequest } from './nodes/HttpRequest';
import { If } from './nodes/If';
import { LlmChain, rankGeminiModels } from './nodes/LlmChain';
import { ManualTrigger } from './nodes/ManualTrigger';
import { Sort } from './nodes/Sort';
import { Limit, NoOp, SplitOut, StickyNote, StopAndError } from './nodes/Utility';
import { LoopOverItems } from './nodes/LoopOverItems';
import { Merge } from './nodes/Merge';
import { RssFeedRead } from './nodes/RssFeedRead';
import { ScheduleTrigger, scheduleToCron } from './nodes/Schedule';
import { ErrorTrigger, ExecuteWorkflow, ExecuteWorkflowTrigger } from './nodes/SubWorkflow';
import { Switch } from './nodes/Switch';
import { Wait } from './nodes/Wait';
import { RespondToWebhook, Webhook } from './nodes/Webhook';
import { WhatsApp, WhatsAppTrigger, normalisePhone, sampleMessage } from './nodes/WhatsApp';
import { YouTube } from './nodes/YouTube';

export * from './credentials';
export { scheduleToCron, normalisePhone, sampleMessage, rankGeminiModels };

export {
  ErrorTrigger,
  ExecuteWorkflow,
  ExecuteWorkflowTrigger,
  LoopOverItems,
  Merge,
  RespondToWebhook,
  ScheduleTrigger,
  Switch,
  Wait,
  Webhook,
  WhatsApp,
  WhatsAppTrigger,
  Aggregate,
  Code,
  DateTimeNode,
  EditFields,
  Filter,
  Gmail,
  GoogleSheets,
  HttpRequest,
  If,
  Limit,
  LlmChain,
  RssFeedRead,
  YouTube,
  ManualTrigger,
  NoOp,
  Sort,
  SplitOut,
  StickyNote,
  StopAndError,
};

/** Every node shipped with FlowForge. */
export const builtinNodes: INodeType[] = [
  ManualTrigger,
  Webhook,
  ScheduleTrigger,
  WhatsAppTrigger,
  ExecuteWorkflowTrigger,
  ErrorTrigger,
  RespondToWebhook,
  WhatsApp,
  LlmChain,
  RssFeedRead,
  GoogleSheets,
  YouTube,
  Gmail,
  Merge,
  Switch,
  LoopOverItems,
  Wait,
  ExecuteWorkflow,
  HttpRequest,
  Code,
  If,
  Filter,
  EditFields,
  Sort,
  Aggregate,
  DateTimeNode,
  Limit,
  SplitOut,
  NoOp,
  StopAndError,
  StickyNote,
];

export class NodeTypeRegistry implements INodeTypes {
  private readonly types = new Map<string, INodeType>();

  constructor(nodes: INodeType[] = []) {
    nodes.forEach((node) => this.register(node));
  }

  register(node: INodeType): void {
    const { name } = node.description;
    if (this.types.has(name)) throw new Error(`Node type "${name}" is registered twice`);
    this.types.set(name, node);
  }

  get(type: string): INodeType | undefined {
    return this.types.get(type);
  }

  getDescription(type: string): INodeTypeDescription | undefined {
    return this.types.get(type)?.description;
  }

  getAll(): INodeType[] {
    return [...this.types.values()];
  }
}

export function createNodeTypes(extra: INodeType[] = []): NodeTypeRegistry {
  return new NodeTypeRegistry([...builtinNodes, ...extra]);
}
