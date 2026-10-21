import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CircleCheck, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';
import { endpoints, getServerUrl, type ApprovalItem } from '../lib/api';

/** Videos (and other things) waiting for your OK - e.g. a Short before it is published. */
export function ApprovalsPage() {
  const approvals = useQuery({
    queryKey: ['approvals'],
    queryFn: endpoints.approvals,
    refetchInterval: 15_000,
  });
  const items = approvals.data?.data ?? [];

  return (
    <div className="ff-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-4 py-8 sm:px-8">
        <div className="mb-6">
          <h1 className="text-xl font-semibold">Approvals</h1>
          <p className="text-[13px] text-muted">
            Watch each video, then approve it to publish or reject it. You also get an email with a
            link that opens this from anywhere.
          </p>
        </div>
        {approvals.isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            icon={CircleCheck}
            title="Nothing to approve"
            description="New videos appear here when a workflow asks for your approval."
          />
        ) : (
          <div className="space-y-4">
            {items.map((item) => (
              <ApprovalCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({ item }: { item: ApprovalItem }) {
  const queryClient = useQueryClient();
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => endpoints.decideApproval(item.id, decision),
    onSuccess: (result) => {
      toast.success(result.message);
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const media = `${getServerUrl()}/approve/${item.id}/media`;
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel" data-testid="approval">
      {item.hasMedia &&
        (item.mediaType?.startsWith('image/') ? (
          <img src={media} alt="" className="max-h-[70vh] w-full bg-black object-contain" />
        ) : (
          <video
            src={media}
            controls
            playsInline
            preload="metadata"
            className="max-h-[70vh] w-full bg-black"
          />
        ))}
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 font-semibold">{item.title}</div>
          <Badge>until {new Date(item.expiresAt).toLocaleString()}</Badge>
        </div>
        {item.description && (
          <p className="whitespace-pre-wrap text-[13px] text-muted">{item.description}</p>
        )}
        <div className="flex gap-2">
          <Button
            className="flex-1"
            variant="danger"
            icon={X}
            loading={decide.isPending && decide.variables === 'reject'}
            disabled={decide.isPending}
            onClick={() => {
              if (window.confirm('Reject this? Nothing will be published.'))
                decide.mutate('reject');
            }}
          >
            Reject
          </Button>
          <Button
            className="flex-1"
            variant="primary"
            icon={Check}
            loading={decide.isPending && decide.variables === 'approve'}
            disabled={decide.isPending}
            onClick={() => decide.mutate('approve')}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
