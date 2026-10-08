import { WorkflowOperationError } from './errors';
import type {
  IConnection,
  INode,
  INodeTypeDescription,
  IPinData,
  IWorkflowBase,
  IWorkflowSettings,
} from './interfaces';

/** Minimal registry interface – implemented by `@flowforge/nodes`. */
export interface INodeTypeLookup {
  getDescription(type: string): INodeTypeDescription | undefined;
}

/**
 * Indexed, read-only view over a workflow JSON graph.
 * Used by the engine at runtime and by the editor for graph operations.
 */
export class Workflow {
  readonly id?: string;
  readonly name: string;
  readonly nodes: INode[];
  readonly connections: IConnection[];
  readonly settings: IWorkflowSettings;
  readonly pinData: IPinData;

  private readonly byId = new Map<string, INode>();
  private readonly byName = new Map<string, INode>();
  private readonly outgoing = new Map<string, IConnection[]>();
  private readonly incoming = new Map<string, IConnection[]>();

  constructor(data: IWorkflowBase) {
    this.id = data.id;
    this.name = data.name;
    this.nodes = data.nodes;
    this.connections = data.connections;
    this.settings = data.settings ?? {};
    this.pinData = data.pinData ?? {};

    for (const node of this.nodes) {
      if (this.byId.has(node.id)) {
        throw new WorkflowOperationError(`Duplicate node id "${node.id}"`, node.name);
      }
      if (this.byName.has(node.name)) {
        throw new WorkflowOperationError(`Duplicate node name "${node.name}"`, node.name);
      }
      this.byId.set(node.id, node);
      this.byName.set(node.name, node);
    }
    for (const conn of this.connections) {
      if (!this.byId.has(conn.source) || !this.byId.has(conn.target)) continue;
      push(this.outgoing, conn.source, conn);
      push(this.incoming, conn.target, conn);
    }
    // Deterministic ordering: by output/input index, then by canvas position (top → bottom).
    for (const list of this.outgoing.values()) {
      list.sort(
        (a, b) =>
          a.sourceOutput - b.sourceOutput ||
          this.positionCompare(this.byId.get(a.target)!, this.byId.get(b.target)!),
      );
    }
  }

  getNode(id: string): INode | undefined {
    return this.byId.get(id);
  }

  getNodeByName(name: string): INode | undefined {
    return this.byName.get(name);
  }

  /** Connections leaving a node (sorted by output index then target position). */
  getOutgoing(nodeId: string, outputIndex?: number): IConnection[] {
    const list = this.outgoing.get(nodeId) ?? [];
    return outputIndex === undefined ? list : list.filter((c) => c.sourceOutput === outputIndex);
  }

  getIncoming(nodeId: string, inputIndex?: number): IConnection[] {
    const list = this.incoming.get(nodeId) ?? [];
    return inputIndex === undefined ? list : list.filter((c) => c.targetInput === inputIndex);
  }

  /** Direct parent node ids. */
  getParents(nodeId: string): string[] {
    return unique(this.getIncoming(nodeId).map((c) => c.source));
  }

  getChildren(nodeId: string): string[] {
    return unique(this.getOutgoing(nodeId).map((c) => c.target));
  }

  /** All ancestors (transitive parents), excluding the node itself. */
  getAncestors(nodeId: string): Set<string> {
    return this.walk(nodeId, (id) => this.getParents(id));
  }

  getDescendants(nodeId: string): Set<string> {
    return this.walk(nodeId, (id) => this.getChildren(id));
  }

  /** Nodes with no incoming connections. */
  getRootNodes(): INode[] {
    return this.nodes.filter((n) => !this.incoming.has(n.id));
  }

  /**
   * Pick the node an execution starts from: an explicit node, or the first
   * enabled trigger (ordered by canvas position).
   */
  getStartNode(lookup: INodeTypeLookup, preferredId?: string): INode {
    if (preferredId) {
      const node = this.byId.get(preferredId) ?? this.byName.get(preferredId);
      if (!node) throw new WorkflowOperationError(`Start node "${preferredId}" does not exist`);
      return node;
    }
    const triggers = this.nodes
      .filter((n) => !n.disabled && lookup.getDescription(n.type)?.group.includes('trigger'))
      .sort((a, b) => this.positionCompare(a, b));
    if (triggers[0]) return triggers[0];
    const roots = this.getRootNodes()
      .filter((n) => !n.disabled && !lookup.getDescription(n.type)?.group.includes('annotation'))
      .sort((a, b) => this.positionCompare(a, b));
    if (roots[0]) return roots[0];
    throw new WorkflowOperationError(
      'The workflow has no trigger node. Add a trigger (e.g. "Manual Trigger") to start it.',
    );
  }

  /** Nodes whose type is a trigger. */
  getTriggerNodes(lookup: INodeTypeLookup): INode[] {
    return this.nodes.filter((n) => lookup.getDescription(n.type)?.group.includes('trigger'));
  }

  private positionCompare(a: INode, b: INode): number {
    return a.position[1] - b.position[1] || a.position[0] - b.position[0];
  }

  private walk(start: string, next: (id: string) => string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...next(start)];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(...next(id));
    }
    seen.delete(start);
    return seen;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
