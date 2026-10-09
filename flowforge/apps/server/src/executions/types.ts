import type { ExecutionMode } from '@prisma/client';
import type {
  INodeExecutionData,
  IRunData,
  IRunExecutionData,
  IWorkflowBase,
} from '@flowforge/workflow';
import type { PushEvent } from '../push/PushHub';

/** How an execution starts; stored with queued executions. */
export interface StartData {
  startNode?: string;
  destinationNode?: string;
  triggerItems?: INodeExecutionData[];
  resumeFrom?: IRunExecutionData;
  resumeData?: INodeExecutionData[];
  runData?: IRunData;
  dirtyNodes?: string[];
}

export interface StartExecutionOptions extends StartData {
  userId: string | null;
  workflowId: string;
  workflowData: IWorkflowBase;
  mode: ExecutionMode;
  retryOfId?: string;
  parentExecutionId?: string;
  /** Run in this process even in queue mode (manual runs, sync webhooks, sub-workflows). */
  inProcess?: boolean;
  /** "Respond to Webhook" callback for sync webhook executions. */
  sendWebhookResponse?: (response: {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
  }) => boolean;
}

export interface PushPublisher {
  publish(topics: string[], event: PushEvent): void;
}
