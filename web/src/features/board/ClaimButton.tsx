import { useState } from 'react';
import { HandMetal } from 'lucide-react';
import type { Task } from 'shared';
import { Button } from '../../components/ui';
import { useAuth } from '../../lib/auth-context';
import { isApiClientError } from '../../api/client';
import { useClaimTask } from '../../api/tasks';

/**
 * Claim control (lifecycle v2 §3/§5). Shown on `open`/`in_progress` cards when the
 * caller is not already a claimant. Any project member may claim → the server adds
 * them to the claimants set and moves an open task to in_progress, recording
 * `claimed`. A conflict (e.g. the task left the claimable states) surfaces inline.
 */
export interface ClaimButtonProps {
  task: Task;
  projectId: string;
  /** Visual size — compact on cards, default in the detail drawer. */
  size?: 'sm' | 'md';
  className?: string;
  /** Optional fired after a successful claim (e.g. close a menu). */
  onClaimed?: () => void;
}

export function ClaimButton({
  task,
  projectId,
  size = 'sm',
  className,
  onClaimed,
}: ClaimButtonProps): JSX.Element | null {
  const { user } = useAuth();
  const claim = useClaimTask(
    projectId,
    user
      ? {
          id: user.id,
          displayName: user.displayName,
          avatarColor: user.avatarColor,
          hasAvatar: user.hasAvatar,
        }
      : undefined,
  );
  const [conflict, setConflict] = useState(false);

  const claimable = task.status === 'open' || task.status === 'in_progress';
  const alreadyClaimant = !!user && task.claimants.some((c) => c.userId === user.id);

  // Only meaningful for a claimable task the logged-in user hasn't already claimed.
  if (!user || !claimable || alreadyClaimant) {
    return null;
  }

  const handleClaim = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setConflict(false);
    claim.mutate(task.id, {
      onSuccess: () => onClaimed?.(),
      onError: (err) => {
        if (isApiClientError(err) && err.isConflict) {
          setConflict(true);
        }
      },
    });
  };

  return (
    <div className={className}>
      <Button
        type="button"
        variant="secondary"
        size={size}
        loading={claim.isPending}
        onClick={handleClaim}
        aria-label="认领任务"
      >
        {!claim.isPending && <HandMetal className="h-3.5 w-3.5" aria-hidden />}
        认领
      </Button>
      {conflict && (
        <p className="mt-1 text-xs text-destructive">该任务暂时无法认领</p>
      )}
    </div>
  );
}
