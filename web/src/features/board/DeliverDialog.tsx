import { useEffect, useMemo, useState } from 'react';
import { PackageCheck } from 'lucide-react';
import type { DeliverTaskInput, Task } from 'shared';
import {
  Avatar,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '../../components/ui';
import { avatarUrl, cn } from '../../lib/utils';
import { isApiClientError } from '../../api/client';
import { useDeliverTask } from '../../api/tasks';

/**
 * Deliver dialog (lifecycle v2 §5). Lists every current claimant with a points
 * input and submits the split for review. The points default to an even split of
 * the task's points (remainder to the first claimant); when the task has no points
 * a 总点数 input supplies the total to split. A live "合计 / 目标" indicator gates
 * the submit button until the sum equals the target.
 */

export interface DeliverDialogProps {
  task: Task;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after a successful deliver (e.g. close a parent drawer/menu). */
  onDelivered?: () => void;
}

/** Even split of `total` across `count` claimants, remainder to the first. */
function evenSplit(total: number, count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i === 0 ? remainder : 0));
}

export function DeliverDialog({
  task,
  projectId,
  open,
  onOpenChange,
  onDelivered,
}: DeliverDialogProps): JSX.Element {
  const claimants = task.claimants;
  const hasFixedPoints = task.points != null;

  const deliver = useDeliverTask(projectId);

  // Per-claimant points (as strings for controlled inputs).
  const [values, setValues] = useState<string[]>([]);
  // Total points input, used only when the task has no points yet.
  const [totalInput, setTotalInput] = useState<string>('');

  // (Re)initialize whenever the dialog opens or the claimant set/points change.
  useEffect(() => {
    if (!open) return;
    if (hasFixedPoints) {
      const split = evenSplit(task.points ?? 0, claimants.length);
      setValues(split.map((n) => String(n)));
      setTotalInput('');
    } else {
      // No fixed points: start the total at 0 and spread evenly (all zeros).
      setValues(claimants.map(() => '0'));
      setTotalInput('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task.id, task.points, claimants.length]);

  const target = hasFixedPoints
    ? (task.points ?? 0)
    : totalInput.trim()
      ? Number(totalInput)
      : NaN;

  const sum = useMemo(
    () => values.reduce((acc, v) => acc + (v.trim() ? Number(v) : 0), 0),
    [values],
  );

  const allValid = values.every((v) => {
    const n = Number(v);
    return v.trim() !== '' && Number.isInteger(n) && n >= 0;
  });
  const targetValid = Number.isInteger(target) && target >= 0;
  const matches = allValid && targetValid && sum === target;

  function setValueAt(index: number, next: string): void {
    setValues((prev) => prev.map((v, i) => (i === index ? next : v)));
  }

  /** When the user edits 总点数, re-spread evenly for convenience. */
  function handleTotalChange(next: string): void {
    setTotalInput(next);
    const n = Number(next);
    if (next.trim() && Number.isInteger(n) && n >= 0) {
      setValues(evenSplit(n, claimants.length).map((x) => String(x)));
    }
  }

  function submit(): void {
    if (!matches) return;
    const allocations: DeliverTaskInput['allocations'] = claimants.map((c, i) => ({
      userId: c.userId,
      points: Number(values[i] ?? '0'),
    }));
    const input: DeliverTaskInput = hasFixedPoints
      ? { allocations }
      : { allocations, totalPoints: target };
    deliver.mutate(
      { taskId: task.id, input },
      {
        onSuccess: () => {
          onOpenChange(false);
          onDelivered?.();
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>交付任务</DialogTitle>
          <DialogDescription>
            为每位认领者分配点数，合计需等于
            {hasFixedPoints ? '任务点数' : '你填写的总点数'}。提交后任务进入「待审阅」。
          </DialogDescription>
        </DialogHeader>

        {!hasFixedPoints && (
          <div className="grid gap-1.5">
            <Label htmlFor="deliver-total" required>
              总点数
            </Label>
            <Input
              id="deliver-total"
              type="number"
              min={0}
              inputMode="numeric"
              placeholder="如 8"
              value={totalInput}
              onChange={(e) => handleTotalChange(e.target.value)}
            />
          </div>
        )}

        <div className="flex flex-col gap-2">
          {claimants.map((c, i) => (
            <div key={c.userId} className="flex items-center gap-3">
              <Avatar
                name={c.displayName}
                color={c.avatarColor}
                imageUrl={c.hasAvatar ? avatarUrl(c.userId) : undefined}
                size="sm"
              />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {c.displayName}
              </span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="w-24"
                aria-label={`${c.displayName} 的点数`}
                value={values[i] ?? ''}
                onChange={(e) => setValueAt(i, e.target.value)}
              />
            </div>
          ))}
        </div>

        {/* Live sum vs target indicator. */}
        <div
          className={cn(
            'flex items-center justify-between rounded-lg border px-3 py-2 text-sm',
            matches
              ? 'border-success/40 bg-success/5 text-success'
              : 'border-border bg-secondary/40 text-muted-foreground',
          )}
        >
          <span>合计</span>
          <span className="tabular-nums">
            <span className={cn('font-semibold', !matches && 'text-foreground')}>{sum}</span>
            {' / '}
            {targetValid ? target : '—'}
          </span>
        </div>

        {deliver.isError && (
          <p className="text-xs text-destructive">
            {isApiClientError(deliver.error) ? deliver.error.message : '交付失败，请重试'}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" loading={deliver.isPending} disabled={!matches} onClick={submit}>
            <PackageCheck className="h-4 w-4" aria-hidden />
            交付
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
