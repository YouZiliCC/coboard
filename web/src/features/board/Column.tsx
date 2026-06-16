import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Task, TaskStatus } from 'shared';
import { cn } from '../../lib/utils';
import { SortableTaskCard } from './SortableTaskCard';
import { STATUS_LABELS } from './labels';
import type { TaskPermissionContext } from './permissions';

/**
 * A single board column (lifecycle v2 §5) — a droppable region hosting a vertical
 * sortable list of task cards. Empty columns remain valid drop targets via the
 * `useDroppable` ref on the column id (the column's status).
 */
export interface ColumnProps {
  status: TaskStatus;
  tasks: Task[];
  projectId: string;
  /** Current user + project role; forwarded to each card for action gating. */
  permCtx: TaskPermissionContext;
  onOpenTask?: (taskId: string) => void;
}

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  open: 'bg-muted-foreground/40',
  in_progress: 'bg-primary',
  pending_review: 'bg-warning',
  done: 'bg-success',
};

export function Column({
  status,
  tasks,
  projectId,
  permCtx,
  onOpenTask,
}: ColumnProps): JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: status, data: { type: 'column', status } });

  return (
    <section
      className="flex h-full min-w-0 flex-1 flex-col rounded-xl bg-secondary/40"
      aria-label={STATUS_LABELS[status]}
    >
      <header className="flex items-center gap-2 px-3 py-2.5">
        <span className={cn('h-2 w-2 rounded-full', COLUMN_ACCENT[status])} aria-hidden />
        <h2 className="text-sm font-semibold text-foreground">{STATUS_LABELS[status]}</h2>
        <span className="ml-auto rounded-full bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {tasks.length}
        </span>
      </header>

      <div
        ref={setNodeRef}
        className={cn(
          'scrollbar-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-3 pt-0.5 transition-colors',
          isOver && 'rounded-lg bg-primary/5 ring-2 ring-inset ring-primary/30',
        )}
      >
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <SortableTaskCard
              key={task.id}
              task={task}
              projectId={projectId}
              permCtx={permCtx}
              onOpen={onOpenTask}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 && (
          <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border/70 px-3 py-8 text-center text-xs text-muted-foreground">
            暂无任务
          </div>
        )}
      </div>
    </section>
  );
}
