import { useState } from 'react';
import { Check, X } from 'lucide-react';
import type { Task } from 'shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from '../../components/ui';
import { isApiClientError } from '../../api/client';
import { useReviewTask } from '../../api/tasks';

/**
 * Review controls for a `pending_review` task (lifecycle v2 §5, lead/admin only).
 * 通过 approves immediately; 驳回 opens a small dialog for an optional reason. Used
 * both on the board card and in the detail drawer.
 */
export interface ReviewActionsProps {
  task: Task;
  projectId: string;
  /** Compact buttons on cards, default in the drawer. */
  size?: 'sm' | 'md';
  className?: string;
  /** Fired after a successful approve/reject. */
  onReviewed?: () => void;
}

export function ReviewActions({
  task,
  projectId,
  size = 'sm',
  className,
  onReviewed,
}: ReviewActionsProps): JSX.Element {
  const review = useReviewTask(projectId);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');

  function approve(): void {
    review.mutate(
      { taskId: task.id, input: { decision: 'approve' } },
      { onSuccess: () => onReviewed?.() },
    );
  }

  function reject(): void {
    review.mutate(
      {
        taskId: task.id,
        input: { decision: 'reject', ...(reason.trim() ? { comment: reason.trim() } : {}) },
      },
      {
        onSuccess: () => {
          setRejectOpen(false);
          setReason('');
          onReviewed?.();
        },
      },
    );
  }

  return (
    <div className={className} onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="primary"
          size={size}
          loading={review.isPending && !rejectOpen}
          onClick={approve}
          aria-label="通过审阅"
        >
          <Check className="h-3.5 w-3.5" aria-hidden />
          通过
        </Button>
        <Button
          type="button"
          variant="outline"
          size={size}
          onClick={() => setRejectOpen(true)}
          aria-label="驳回交付"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
          驳回
        </Button>
      </div>

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>驳回交付</DialogTitle>
            <DialogDescription>
              任务将退回「进行中」，已分配的点数会被清空。可填写驳回理由。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="reject-reason">驳回理由（选填）</Label>
            <Textarea
              id="reject-reason"
              rows={3}
              placeholder="说明需要修改的地方…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          {review.isError && (
            <p className="text-xs text-destructive">
              {isApiClientError(review.error) ? review.error.message : '操作失败，请重试'}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRejectOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              loading={review.isPending}
              onClick={reject}
            >
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
