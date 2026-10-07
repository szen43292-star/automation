import type { INodeExecutionData, IRunData, ITaskData } from './interfaces';

/** Resolve the input items of a task from the source references stored in run data. */
export function getTaskInput(
  runData: IRunData,
  task: ITaskData,
  inputIndex = 0,
): INodeExecutionData[] | null {
  const source = task.source[inputIndex];
  if (!source) return null;
  const parentRun = runData[source.previousNode]?.[source.previousNodeRun];
  return parentRun?.data?.main[source.previousNodeOutput] ?? null;
}

/** Number of items per output of a task. */
export function getTaskItemCounts(task: ITaskData): number[] {
  return (task.data?.main ?? []).map((items) => items?.length ?? 0);
}

/** Small summary pushed to clients while an execution runs. */
export interface ITaskSummary {
  status: ITaskData['executionStatus'];
  executionTime: number;
  itemCounts: number[];
  error?: { message: string; description?: string };
}

export function summariseTask(task: ITaskData): ITaskSummary {
  return {
    status: task.executionStatus,
    executionTime: task.executionTime,
    itemCounts: getTaskItemCounts(task),
    error: task.error ? { message: task.error.message, description: task.error.description } : undefined,
  };
}
