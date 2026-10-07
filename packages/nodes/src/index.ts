import type { INodeType, INodeTypeDescription, INodeTypes } from '@flowforge/workflow';
import { Aggregate } from './nodes/Aggregate';
import { Code } from './nodes/Code';
import { DateTimeNode } from './nodes/DateTime';
import { EditFields } from './nodes/EditFields';
import { Filter } from './nodes/Filter';
import { HttpRequest } from './nodes/HttpRequest';
import { If } from './nodes/If';
import { ManualTrigger } from './nodes/ManualTrigger';
import { Sort } from './nodes/Sort';
import { Limit, NoOp, SplitOut, StickyNote, StopAndError } from './nodes/Utility';
import { LoopOverItems } from './nodes/LoopOverItems';
import { Merge } from './nodes/Merge';
import { ScheduleTrigger, scheduleToCron } from './nodes/Schedule';
import { ErrorTrigger, ExecuteWorkflow, ExecuteWorkflowTrigger } from './nodes/SubWorkflow';
import { Switch } from './nodes/Switch';
import { Wait } from './nodes/Wait';
import { RespondToWebhook, Webhook } from './nodes/Webhook';

export * from './credentials';
export { scheduleToCron };

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
  Aggregate,
  Code,
  DateTimeNode,
  EditFields,
  Filter,
  HttpRequest,
  If,
  Limit,
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
  ExecuteWorkflowTrigger,
  ErrorTrigger,
  RespondToWebhook,
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
