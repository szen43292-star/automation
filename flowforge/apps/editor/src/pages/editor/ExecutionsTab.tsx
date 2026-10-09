import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bug, History, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { endpoints, type ExecutionSummary } from '../../lib/api';
import { formatDateTime, formatDuration, timeAgo } from '../../lib/format';
import { push } from '../../lib/push';
import { useEditor } from '../../stores/editor';
import { Canvas } from '../../components/canvas/Canvas';
import { NodeDetailsView } from '../../components/ndv/NodeDetailsView';
import { Button, EmptyState, Menu, Spinner } from '../../components/ui';
import { StatusBadge } from '../ExecutionsPage';

export function ExecutionsTab({
  workflowId,
  executionId,
}: {
  workflowId: string;
  executionId?: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: ['executions', workflowId],
    queryFn: ({ pageParam }) => endpoints.executions({ workflowId, cursor: pageParam, limit: 30 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
  const executions = list.data?.pages.flatMap((p) => p.data) ?? [];

  // Refresh the list as soon as an execution starts or finishes.
  useEffect(() => {
    const unsubscribe = push.subscribe(`workflow:${workflowId}`);
    const off = push.on((m) => {
      if (
        (m.type === 'executionFinished' || m.type === 'executionStarted') &&
        m.data.workflowId === workflowId
      ) {
        void queryClient.invalidateQueries({ queryKey: ['executions', workflowId] });
      }
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [workflowId, queryClient]);

  // Open the newest execution by default.
  useEffect(() => {
    if (!executionId && executions[0])
      navigate(`/workflow/${workflowId}/executions/${executions[0].id}`, { replace: true });
  }, [executionId, executions, navigate, workflowId]);

  return (
    <div className="flex h-full">
      <aside className="ff-scroll w-72 shrink-0 overflow-y-auto border-r border-line bg-panel">
        {list.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : executions.length === 0 ? (
          <EmptyState
            icon={History}
            title="No executions yet"
            description="Run the workflow from the editor to see its history here."
          />
        ) : (
          <>
            {executions.map((e) => (
              <ExecutionRow
                key={e.id}
                execution={e}
                selected={e.id === executionId}
                onClick={() => navigate(`/workflow/${workflowId}/executions/${e.id}`)}
              />
            ))}
            {list.hasNextPage && (
              <div className="p-3">
                <Button
                  size="sm"
                  className="w-full"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </>
        )}
      </aside>
      <div className="relative min-w-0 flex-1">
        {executionId ? (
          <ExecutionPreview workflowId={workflowId} executionId={executionId} />
        ) : null}
      </div>
    </div>
  );
}

function ExecutionRow({
  execution,
  selected,
  onClick,
}: {
  execution: ExecutionSummary;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'block w-full border-b border-l-3 border-b-line px-3 py-2.5 text-left',
        selected ? 'border-l-accent bg-panel-2' : 'border-l-transparent hover:bg-panel-2',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{formatDateTime(execution.startedAt)}</span>
        <StatusBadge status={execution.status} />
      </div>
      <div className="mt-0.5 text-xs text-muted">
        {execution.mode} · {formatDuration(execution.durationMs)} · {timeAgo(execution.startedAt)}
      </div>
    </button>
  );
}

function ExecutionPreview({
  workflowId,
  executionId,
}: {
  workflowId: string;
  executionId: string;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ['execution', executionId],
    queryFn: () => endpoints.execution(executionId),
    refetchInterval: (q) => (q.state.data?.running ? 1500 : false),
  });

  useEffect(() => {
    const data = detail.data;
    if (!data?.workflowData) return;
    const state = useEditor.getState();
    state.load({ ...data.workflowData, id: workflowId }, { readOnly: true });
    state.applyExecution(data);
  }, [detail.data, workflowId]);

  if (detail.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <div className="p-6 text-danger">
        {(detail.error as Error)?.message ?? 'Execution not found'}
      </div>
    );
  }
  const execution = detail.data;
  const canRetry = ['error', 'crashed', 'canceled'].includes(execution.status);

  const retry = async (useCurrentWorkflow: boolean) => {
    try {
      const { executionId: id } = await endpoints.retryExecution(executionId, useCurrentWorkflow);
      toast.success('Retry started');
      await queryClient.invalidateQueries({ queryKey: ['executions', workflowId] });
      navigate(`/workflow/${workflowId}/executions/${id}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  };

  return (
    <>
      <div className="absolute top-3 right-3 left-3 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3 py-2 shadow-card">
        <StatusBadge status={execution.status} />
        <span className="text-[13px] font-medium">{formatDateTime(execution.startedAt)}</span>
        <span className="text-xs text-muted">
          #{execution.id.slice(-8)} · {execution.mode}
          {execution.retryOfId ? ' · retry' : ''}
        </span>
        {execution.errorMessage && (
          <span className="max-w-md truncate text-xs text-danger" title={execution.errorMessage}>
            {execution.lastNodeExecuted ? `${execution.lastNodeExecuted}: ` : ''}
            {execution.errorMessage}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            icon={Bug}
            onClick={() =>
              navigate(`/workflow/${workflowId}`, { state: { debugExecutionId: executionId } })
            }
          >
            Debug in editor
          </Button>
          {canRetry && (
            <Menu
              trigger={
                <Button size="sm" icon={RotateCcw}>
                  Retry
                </Button>
              }
              items={[
                { label: 'Retry with original workflow', onClick: () => void retry(false) },
                { label: 'Retry with currently saved workflow', onClick: () => void retry(true) },
              ]}
            />
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            disabled={execution.running}
            onClick={async () => {
              if (!window.confirm('Delete this execution?')) return;
              await endpoints.deleteExecution(executionId);
              await queryClient.invalidateQueries({ queryKey: ['executions', workflowId] });
              navigate(`/workflow/${workflowId}/executions`, { replace: true });
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <Canvas />
      <NodeDetailsView />
    </>
  );
}
