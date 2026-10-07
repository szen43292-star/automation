import type { INodeType, INodeTypeDescription, INodeTypes } from '@flowforge/workflow';
import { Aggregate } from './nodes/Aggregate.node';
import { Code } from './nodes/Code.node';
import { DateTimeNode } from './nodes/DateTime.node';
import { EditFields } from './nodes/EditFields.node';
import { Filter } from './nodes/Filter.node';
import { HttpRequest } from './nodes/HttpRequest.node';
import { If } from './nodes/If.node';
import { ManualTrigger } from './nodes/ManualTrigger.node';
import { Sort } from './nodes/Sort.node';
import { Limit, NoOp, SplitOut, StickyNote, StopAndError } from './nodes/Utility.nodes';

export {
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
