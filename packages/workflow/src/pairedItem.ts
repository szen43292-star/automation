import type { INodeExecutionData, IPairedItem, IRunData, ISourceData } from './interfaces';

export function normalisePairedItem(value: INodeExecutionData['pairedItem']): IPairedItem[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'number') return [{ item: value }];
  return Array.isArray(value) ? value : [value];
}

export type PairedItemResult =
  | { ok: true; item: INodeExecutionData }
  | { ok: false; reason: 'notExecuted' | 'notAncestor' | 'missingPairing' };

/**
 * Follow `pairedItem` links backwards from an item to the item of `targetNode`
 * it was derived from. This is what `$('Lookup').item` resolves to.
 *
 * @param source where the current node's input came from
 * @param itemIndex index of the current item in that input
 */
export function resolvePairedItem(
  runData: IRunData,
  source: ISourceData | null | undefined,
  itemIndex: number,
  targetNode: string,
): PairedItemResult {
  if (!runData[targetNode]?.length) return { ok: false, reason: 'notExecuted' };
  let current = source;
  let index = itemIndex;
  for (let guard = 0; current && guard < 10_000; guard++) {
    const task = runData[current.previousNode]?.[current.previousNodeRun];
    const item = task?.data?.main[current.previousNodeOutput]?.[index];
    if (!task || !item) return { ok: false, reason: 'missingPairing' };
    if (current.previousNode === targetNode) return { ok: true, item };
    const paired = normalisePairedItem(item.pairedItem)[0];
    if (!paired) return { ok: false, reason: 'missingPairing' };
    current = task.source[paired.input ?? 0];
    index = paired.item;
  }
  return { ok: false, reason: 'notAncestor' };
}
