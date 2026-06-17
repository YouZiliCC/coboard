import { Users } from 'lucide-react';
import type { Task } from 'shared';
import { Badge } from '../../components/ui';
import { cn } from '../../lib/utils';
import { isBelowMinClaimants, isClaimFull } from './permissions';

/**
 * Claim-count status pill (claim-limits feature). While a task is in the active
 * pool (open / in_progress) it surfaces:
 *  - 「未达下限 X/Y」 when the task still needs more claimants to start — only for
 *    tasks that actually require several (minClaimants > 1); a plain 1-person task
 *    in 待认领 needs no pill.
 *  - 「已满 X/Y」 when the upper bound has been reached (no more claims accepted).
 * Otherwise it renders nothing (a normal claimable task needs no annotation).
 */
export function ClaimLimitBadge({
  task,
  className,
}: {
  task: Task;
  className?: string;
}): JSX.Element | null {
  if (task.status !== 'open' && task.status !== 'in_progress') return null;

  const count = task.claimants.length;
  const belowMin = task.status === 'open' && task.minClaimants > 1 && isBelowMinClaimants(task);

  if (belowMin) {
    return (
      <Badge variant="warning" className={cn('gap-1', className)} title="认领人数未达下限，任务保持在待认领">
        <Users className="h-3 w-3 shrink-0" aria-hidden />
        未达下限 {count}/{task.minClaimants}
      </Badge>
    );
  }

  if (isClaimFull(task)) {
    return (
      <Badge variant="neutral" className={cn('gap-1', className)} title="已达认领人数上限">
        <Users className="h-3 w-3 shrink-0" aria-hidden />
        已满 {count}/{task.maxClaimants}
      </Badge>
    );
  }

  return null;
}
