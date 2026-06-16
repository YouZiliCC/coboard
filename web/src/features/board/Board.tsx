import { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { ClipboardList } from 'lucide-react';
import type { Task, TaskStatus } from 'shared';
import { taskStatuses } from 'shared';
import { EmptyState, FullPageSpinner } from '../../components/ui';
import { useAuth } from '../../lib/auth-context';
import { usePatchTask, useProjectMembers, useReviewTask } from '../../api/tasks';
import { TaskDetailDrawer } from '../task/TaskDetailDrawer';
import { Column } from './Column';
import { TaskCard } from './TaskCard';
import { CreateTaskDialog } from './CreateTaskDialog';
import { DeliverDialog } from './DeliverDialog';
import {
  BoardFilters,
  FILTER_ALL,
  FILTER_ME,
  type AssigneeFilter,
} from './BoardFilters';
import { COLUMN_ORDER } from './labels';
import { canDeliver, canEditTask, canReview, resolveProjectRole } from './permissions';
import { rankBetween } from './rank';

/**
 * The kanban board (lifecycle v2 §5). Four columns: 待认领 / 进行中 / 待审阅 /
 * 已完成. Drag-and-drop: reorder within a column (rank PATCH), drag open↔in_progress
 * (status PATCH); dragging a card into 待审阅 opens the deliver dialog when the
 * caller is a claimant (else it snaps back with a hint); dragging into 已完成
 * triggers a review-approve for a lead/admin (else snaps back). Controlled
 * transitions are preferred via the card buttons; drag is a convenience.
 */
export interface BoardProps {
  projectId: string;
  tasks: Task[];
  isLoading: boolean;
}

function isTaskStatus(value: string): value is TaskStatus {
  return (taskStatuses as readonly string[]).includes(value);
}

export function Board({ projectId, tasks, isLoading }: BoardProps): JSX.Element {
  const { user } = useAuth();
  const { data: members } = useProjectMembers(projectId);
  const patchTask = usePatchTask(projectId);
  const reviewTask = useReviewTask(projectId);

  const [filter, setFilter] = useState<AssigneeFilter>(FILTER_ALL);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  /** A drag-into-待审阅 that needs the deliver dialog. */
  const [deliverTaskId, setDeliverTaskId] = useState<string | null>(null);
  /** Transient hint shown when a drag move is not allowed. */
  const [hint, setHint] = useState<string | null>(null);

  const sensors = useSensors(
    // 5px activation distance lets a click open the drawer without starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const projectRole = resolveProjectRole(members, user?.id);
  const permCtx = useMemo(() => ({ user, projectRole }), [user, projectRole]);

  // Auto-dismiss the transient hint.
  useEffect(() => {
    if (!hint) return;
    const id = window.setTimeout(() => setHint(null), 3000);
    return () => window.clearTimeout(id);
  }, [hint]);

  /** Apply the claimant filter to the flat task list (v2: filter by claimants). */
  const filtered = useMemo(() => {
    if (filter === FILTER_ALL) return tasks;
    const target = filter === FILTER_ME ? user?.id : filter;
    if (!target) return tasks;
    return tasks.filter((t) => t.claimants.some((c) => c.userId === target));
  }, [tasks, filter, user?.id]);

  /** Group filtered tasks by column, sorted by rank then creation time. */
  const columns = useMemo(() => {
    const byStatus: Record<TaskStatus, Task[]> = {
      open: [],
      in_progress: [],
      pending_review: [],
      done: [],
    };
    for (const task of filtered) byStatus[task.status].push(task);
    for (const status of COLUMN_ORDER) {
      byStatus[status].sort((a, b) => {
        if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
        return a.createdAt < b.createdAt ? -1 : 1;
      });
    }
    return byStatus;
  }, [filtered]);

  const activeTask = activeId ? tasks.find((t) => t.id === activeId) : undefined;
  const deliverTaskObj = deliverTaskId ? tasks.find((t) => t.id === deliverTaskId) : undefined;

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent): void {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;

    const task = tasks.find((t) => t.id === String(active.id));
    if (!task) return;

    // Resolve the destination column: `over` is either a column droppable (id =
    // status) or another task (resolve to that task's column).
    const overId = String(over.id);
    let destStatus: TaskStatus;
    if (isTaskStatus(overId)) {
      destStatus = overId;
    } else {
      const overTask = tasks.find((t) => t.id === overId);
      if (!overTask) return;
      destStatus = overTask.status;
    }

    const sameColumn = destStatus === task.status;

    // Cross-column moves into the controlled states (审阅/完成) are driven by the
    // dialogs / review action, not by a plain status PATCH.
    if (!sameColumn) {
      if (destStatus === 'pending_review') {
        if (task.status === 'in_progress' && canDeliver(permCtx, task)) {
          setDeliverTaskId(task.id);
        } else {
          setHint('请用「交付」按钮提交点数分配');
        }
        return;
      }
      if (destStatus === 'done') {
        if (canReview(permCtx, task)) {
          reviewTask.mutate({ taskId: task.id, input: { decision: 'approve' } });
        } else if (task.status === 'pending_review') {
          setHint('仅项目负责人可以通过审阅');
        } else {
          setHint('请先交付任务，等待审阅通过');
        }
        return;
      }
      // open ↔ in_progress: only a direct status change is allowed via drag.
      if (
        (task.status === 'open' || task.status === 'in_progress') &&
        (destStatus === 'open' || destStatus === 'in_progress')
      ) {
        if (!canEditTask(permCtx, task)) {
          setHint('没有权限移动该任务');
          return;
        }
      } else {
        setHint('该状态变更需通过交付 / 审阅完成');
        return;
      }
    } else if (!canEditTask(permCtx, task)) {
      // Intra-column reorder still requires edit permission.
      return;
    }

    // Build the destination list as it appears now (sorted), excluding the dragged
    // task, to compute neighbours for the new rank.
    const destList = columns[destStatus].filter((t) => t.id !== task.id);
    let insertIndex = destList.length;
    if (!isTaskStatus(overId)) {
      const idx = destList.findIndex((t) => t.id === overId);
      if (idx !== -1) insertIndex = idx;
    }

    const before = insertIndex > 0 ? destList[insertIndex - 1]!.rank : null;
    const after = insertIndex < destList.length ? destList[insertIndex]!.rank : null;

    const samePosition =
      sameColumn &&
      columns[destStatus].findIndex((t) => t.id === task.id) === insertIndex;
    if (samePosition && before === null && after === null) return;

    const newRank = rankBetween(before, after);

    // No-op guard: identical rank and status.
    if (sameColumn && newRank === task.rank) return;

    const patch = sameColumn
      ? { rank: newRank }
      : { status: destStatus, rank: newRank };

    patchTask.mutate({ taskId: task.id, patch });
  }

  if (isLoading) {
    return <FullPageSpinner />;
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <BoardFilters
          value={filter}
          onChange={setFilter}
          members={members ?? []}
          currentUserId={user?.id}
        />
        <div className="ml-auto">
          <CreateTaskDialog projectId={projectId} />
        </div>
      </div>

      {/* Transient drag hint */}
      {hint && (
        <div className="px-4 sm:px-6" role="status">
          <p className="mb-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
            {hint}
          </p>
        </div>
      )}

      {/* Board */}
      {tasks.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 pb-6">
          <EmptyState
            icon={ClipboardList}
            title="还没有任务"
            description="点击右上角「新建任务」开始安排工作。"
          />
        </div>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:px-6">
            {COLUMN_ORDER.map((status) => (
              <Column
                key={status}
                status={status}
                tasks={columns[status]}
                projectId={projectId}
                permCtx={permCtx}
                onOpenTask={setOpenTaskId}
              />
            ))}
          </div>

          <DragOverlay dropAnimation={null}>
            {activeTask ? (
              <TaskCard task={activeTask} projectId={projectId} dragging />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* Drag-into-待审阅 deliver dialog */}
      {deliverTaskObj && (
        <DeliverDialog
          task={deliverTaskObj}
          projectId={projectId}
          open={deliverTaskId !== null}
          onOpenChange={(next) => {
            if (!next) setDeliverTaskId(null);
          }}
        />
      )}

      {/* Detail drawer */}
      <TaskDetailDrawer
        taskId={openTaskId}
        projectId={projectId}
        open={openTaskId !== null}
        onOpenChange={(next) => {
          if (!next) setOpenTaskId(null);
        }}
      />
    </div>
  );
}
