import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, History, Loader2, Timer, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { endpoints, type ExecutionStatus } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { push } from '../lib/push';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';

export function StatusBadge({ status }: { status: ExecutionStatus }) {
  switch (status) {
    case 'success':
      return (
        <Badge tone="success">
          <CheckCircle2 size={12} /> Success
        </Badge>
      );
    case 'error':
      return (
        <Badge tone="danger">
          <XCircle size={12} /> Error
        </Badge>
      );
    case 'crashed':
      return (
        <Badge tone="danger">
          <XCircle size={12} /> Crashed
        </Badge>
      );
    case 'running':
    case 'new':
      return (
        <Badge tone="accent">
          <Loader2 size={12} className="ff-spin" /> Running
        </Badge>
      );
    case 'waiting':
      return (
        <Badge tone="info">
          <Timer size={12} /> Waiting
        </Badge>
      );
    case 'canceled':
      return (
        <Badge tone="warning">
          <CircleSlash size={12} /> Cancelled
        </Badge>
      );
  }
}

const FILTERS: Array<[string, string]> = [
  ['', 'All'],
  ['success', 'Succeeded'],
  ['error,crashed', 'Failed'],
  ['running', 'Running'],
  ['canceled', 'Cancelled'],
];

export function ExecutionsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const query = useInfiniteQuery({
    queryKey: ['executions', 'all', status],
    queryFn: ({ pageParam }) =>
      endpoints.executions({ status: status || undefined, cursor: pageParam, limit: 50 }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = query.data?.pages.flatMap((p) => p.data) ?? [];

  useEffect(
    () =>
      push.on((m) => {
        if (m.type === 'executionFinished')
          void queryClient.invalidateQueries({ queryKey: ['executions', 'all'] });
      }),
    [queryClient],
  );

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Executions</h1>
          <p className="text-[13px] text-muted">
            Every run of every workflow, with the data each node produced.
          </p>
        </div>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {FILTERS.map(([value, label]) => (
            <button
              key={label}
              onClick={() => setStatus(value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium ${status === value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {query.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon={History}
            title="No executions found"
            description="Executions appear here when workflows run."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-[13px]">
              <thead className="bg-panel-2 text-left text-xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Workflow</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Mode</th>
                  <th className="px-4 py-2 font-medium">ID</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-t border-line hover:bg-panel-2"
                    onClick={() => navigate(`/workflow/${row.workflowId}/executions/${row.id}`)}
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{row.workflowName}</div>
                      {row.errorMessage && (
                        <div className="max-w-md truncate text-xs text-danger">
                          {row.errorMessage}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap text-muted">
                      {formatDateTime(row.startedAt)}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{formatDuration(row.durationMs)}</td>
                    <td className="px-4 py-2.5 text-muted capitalize">{row.mode}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{row.id.slice(-8)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {query.hasNextPage && (
              <div className="border-t border-line p-3 text-center">
                <Button
                  size="sm"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Load more
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
