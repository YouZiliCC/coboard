import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Task } from 'shared';
import { cn } from '../../lib/utils';
import { TaskCard } from './TaskCard';
import type { TaskPermissionContext } from './permissions';

/**
 * dnd-kit sortable wrapper around {@link TaskCard} (§6.1). Makes the card
 * draggable within and across columns; the actual PATCH (status/rank) is issued
 * by the board's drag handlers. The whole card is the drag handle, but clicks
 * still open the drawer (dnd-kit distinguishes click from drag via an activation
 * distance configured on the sensors).
 */
export interface SortableTaskCardProps {
  task: Task;
  projectId: string;
  permCtx: TaskPermissionContext;
  onOpen?: (taskId: string) => void;
}

export function SortableTaskCard({
  task,
  projectId,
  permCtx,
  onOpen,
}: SortableTaskCardProps): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'task', status: task.status },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={cn('touch-none', isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <TaskCard task={task} projectId={projectId} permCtx={permCtx} onOpen={onOpen} />
    </div>
  );
}
