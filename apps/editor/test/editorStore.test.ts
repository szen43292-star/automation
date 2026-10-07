import { beforeEach, describe, expect, it } from 'vitest';
import type { INodeTypeDescription } from '@flowforge/workflow';
import { useEditor } from '../src/stores/editor';
import { useNodeTypes } from '../src/stores/nodeTypes';

const description = (
  name: string,
  extra: Partial<INodeTypeDescription> = {},
): INodeTypeDescription => ({
  name,
  displayName: name,
  icon: 'box',
  group: ['core'],
  version: 1,
  description: name,
  defaults: { name: extra.displayName ?? name },
  inputs: [{ type: 'main' }],
  outputs: [{ type: 'main' }],
  properties: [{ displayName: 'Value', name: 'value', type: 'string', default: 'x' }],
  ...extra,
});

const types = [
  description('trigger', {
    group: ['trigger'],
    inputs: [],
    maxNodes: 1,
    displayName: 'Trigger',
    defaults: { name: 'Trigger' },
  }),
  description('set', { displayName: 'Set', defaults: { name: 'Set' } }),
];

const editor = () => useEditor.getState();

beforeEach(() => {
  useNodeTypes.setState({
    list: types,
    byName: Object.fromEntries(types.map((t) => [t.name, t])),
    loaded: true,
  });
  editor().reset();
});

describe('editor store', () => {
  it('adds nodes with defaults, unique names and auto-connection', () => {
    const trigger = editor().addNode('trigger', { position: { x: 0, y: 0 } })!;
    const a = editor().addNode('set', { source: { nodeId: trigger.id, output: 0 } })!;
    const b = editor().addNode('set', { source: { nodeId: a.id, output: 0 } })!;
    expect(a.parameters).toEqual({ value: 'x' });
    expect([a.name, b.name]).toEqual(['Set', 'Set1']);
    expect(a.position).toEqual([220, 0]);
    expect(editor().connections).toHaveLength(2);
    expect(editor().addNode('trigger')).toBeNull(); // maxNodes = 1
    expect(editor().dirty).toBe(true);
  });

  it('undoes and redoes changes', () => {
    editor().addNode('trigger', { position: { x: 0, y: 0 } });
    editor().addNode('set', { position: { x: 200, y: 0 } });
    expect(editor().nodes).toHaveLength(2);
    editor().undo();
    expect(editor().nodes).toHaveLength(1);
    editor().undo();
    expect(editor().nodes).toHaveLength(0);
    editor().redo();
    editor().redo();
    expect(editor().nodes.map((n) => n.name)).toEqual(['Trigger', 'Set']);
  });

  it('merges rapid edits of the same parameter into one undo step', () => {
    const node = editor().addNode('set', { position: { x: 0, y: 0 } })!;
    editor().setParameters(node.id, { value: 'a' });
    editor().setParameters(node.id, { value: 'ab' });
    editor().setParameters(node.id, { value: 'abc' });
    editor().undo();
    expect(editor().nodes[0]!.parameters.value).toBe('x');
  });

  it('reconnects neighbours when deleting a node in the middle of a chain', () => {
    const t = editor().addNode('trigger', { position: { x: 0, y: 0 } })!;
    const a = editor().addNode('set', { source: { nodeId: t.id, output: 0 } })!;
    const b = editor().addNode('set', { source: { nodeId: a.id, output: 0 } })!;
    editor().removeNodes([a.id]);
    expect(editor().connections).toEqual([
      { source: t.id, sourceOutput: 0, target: b.id, targetInput: 0 },
    ]);
  });

  it('renames nodes and rewrites expression references', () => {
    const a = editor().addNode('set', { position: { x: 0, y: 0 } })!;
    const b = editor().addNode('set', { position: { x: 200, y: 0 } })!;
    editor().setParameters(b.id, {
      value: `={{ $node["Set"].json.x }} and {{ $('Set').item.json.y }}`,
    });
    expect(editor().renameNode(a.id, 'Lookup')).toBe('Lookup');
    expect(editor().nodes.find((n) => n.id === b.id)!.parameters.value).toBe(
      `={{ $node["Lookup"].json.x }} and {{ $('Lookup').item.json.y }}`,
    );
    expect(editor().renameNode(b.id, 'Lookup')).toBeNull(); // duplicate name
  });

  it('pastes nodes with fresh ids, unique names and internal connections', () => {
    const t = editor().addNode('trigger', { position: { x: 0, y: 0 } })!;
    const a = editor().addNode('set', { source: { nodeId: t.id, output: 0 } })!;
    editor().setSelection([t.id, a.id]);
    const clipboard = editor().copySelection()!;
    expect(clipboard.nodes).toHaveLength(2);
    const added = editor().paste(JSON.parse(JSON.stringify(clipboard)));
    expect(added).toBe(1); // second trigger is skipped (maxNodes)
    const pasted = editor().nodes[2]!;
    expect(pasted.name).toBe('Set1');
    expect(pasted.id).not.toBe(a.id);
    expect(editor().paste({ nonsense: true })).toBe(0);
  });

  it('tracks live execution status from push messages', () => {
    editor().startExecution('e1');
    editor().applyPush({
      type: 'nodeExecuteBefore',
      data: { executionId: 'e1', workflowId: 'w', nodeName: 'Set' },
    });
    expect(editor().nodeStatus.Set!.status).toBe('running');
    editor().applyPush({
      type: 'nodeExecuteAfter',
      data: {
        executionId: 'e1',
        workflowId: 'w',
        nodeName: 'Set',
        runIndex: 0,
        status: 'success',
        executionTime: 3,
        itemCounts: [4],
      },
    });
    expect(editor().nodeStatus.Set).toMatchObject({ status: 'success', itemCounts: [4], runs: 1 });
    // Events of other executions are ignored.
    editor().applyPush({
      type: 'nodeExecuteBefore',
      data: { executionId: 'other', workflowId: 'w', nodeName: 'Set' },
    });
    expect(editor().nodeStatus.Set!.status).toBe('success');
  });

  it('is read-only when viewing past executions', () => {
    editor().load({ name: 'x', nodes: [], connections: [], settings: {} }, { readOnly: true });
    expect(editor().addNode('set')).toBeNull();
  });
});
