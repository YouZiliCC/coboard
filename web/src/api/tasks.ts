import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AssignTaskInput,
  BoardResponse,
  CreateTaskInput,
  DeliverTaskInput,
  ProjectMembersResponse,
  ProjectMemberWithUser,
  ReviewTaskInput,
  Task,
  TaskClaimant,
  TaskResponse,
  UpdateTaskInput,
} from 'shared';
import { api } from './client';
import { queryKeys } from '../lib/query';

/**
 * Task data + mutation hooks (§7 tasks). Reads drive the kanban board and the
 * task detail drawer; writes use TanStack Query OPTIMISTIC updates so the acting
 * user sees instant feedback while the request is in flight. Other clients are
 * refreshed by the SSE invalidation layer (§6.5, lib/sse.ts).
 *
 * Optimistic pattern (per mutation):
 *  - onMutate: cancel in-flight board/task queries, snapshot caches, apply the
 *    predicted next state, return the snapshot as rollback context.
 *  - onError: restore the snapshot (so a 409 lost-claim race etc. reverts).
 *  - onSettled: invalidate the affected queries to reconcile with the server.
 */

// ---------------------------------------------------------------------------
// Low-level fetchers — shared by hooks and mutation reconciliation.
// ---------------------------------------------------------------------------

/**
 * Sentinel projectId for the "全部项目" board (§8). Used as the `:projectId` route
 * param and as the cache key for {@link useAllTasks}; `queryKeys.allTasks()` is
 * `queryKeys.board(ALL_PROJECTS)` so the optimistic helpers reuse that cache.
 */
export const ALL_PROJECTS = 'all';

export const tasksApi = {
  board: (projectId: string, signal?: AbortSignal): Promise<BoardResponse> =>
    api.get<BoardResponse>(`/projects/${projectId}/tasks`, { signal }),
  /** Every task the caller can see across projects + the no-project pool (§8). */
  all: (signal?: AbortSignal): Promise<BoardResponse> =>
    api.get<BoardResponse>('/tasks/all', { signal }),
  get: (taskId: string, signal?: AbortSignal): Promise<TaskResponse> =>
    api.get<TaskResponse>(`/tasks/${taskId}`, { signal }),
  /**
   * Unified create (§8 POST /tasks). With `projectId` → a project task (caller
   * must be a member); without → a no-project (pool) task.
   */
  create: (body: CreateTaskInput): Promise<TaskResponse> =>
    api.post<TaskResponse>('/tasks', body),
  update: (taskId: string, body: UpdateTaskInput): Promise<TaskResponse> =>
    api.patch<TaskResponse>(`/tasks/${taskId}`, body),
  claim: (taskId: string): Promise<TaskResponse> =>
    api.post<TaskResponse>(`/tasks/${taskId}/claim`),
  release: (taskId: string, userId?: string): Promise<TaskResponse> =>
    api.post<TaskResponse>(
      `/tasks/${taskId}/release`,
      userId ? { userId } : undefined,
    ),
  assign: (taskId: string, body: AssignTaskInput): Promise<TaskResponse> =>
    api.post<TaskResponse>(`/tasks/${taskId}/assign`, body),
  deliver: (taskId: string, body: DeliverTaskInput): Promise<TaskResponse> =>
    api.post<TaskResponse>(`/tasks/${taskId}/deliver`, body),
  review: (taskId: string, body: ReviewTaskInput): Promise<TaskResponse> =>
    api.post<TaskResponse>(`/tasks/${taskId}/review`, body),
  remove: (taskId: string): Promise<void> => api.delete<void>(`/tasks/${taskId}`),
  members: (projectId: string, signal?: AbortSignal): Promise<ProjectMembersResponse> =>
    api.get<ProjectMembersResponse>(`/projects/${projectId}/members`, { signal }),
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Board tasks for a project (§7 GET /projects/:id/tasks). */
export function useBoardTasks(projectId: string | undefined): UseQueryResult<Task[]> {
  return useQuery<Task[]>({
    queryKey: projectId ? queryKeys.board(projectId) : ['projects', '__none__', 'tasks'],
    queryFn: async ({ signal }) => {
      const res = await tasksApi.board(projectId!, signal);
      return res.tasks;
    },
    enabled: projectId !== undefined,
  });
}

/**
 * All tasks visible to the current user — their member projects' tasks plus every
 * no-project (pool) task (§8 GET /tasks/all). Powers the "全部项目" board; each
 * task carries `projectName`/`projectKey` (null for pool tasks) for the badge.
 */
export function useAllTasks(enabled = true): UseQueryResult<Task[]> {
  return useQuery<Task[]>({
    queryKey: queryKeys.allTasks(),
    queryFn: async ({ signal }) => {
      const res = await tasksApi.all(signal);
      return res.tasks;
    },
    enabled,
  });
}

/** A single task by id (§7 GET /tasks/:id). */
export function useTask(taskId: string | undefined): UseQueryResult<Task> {
  return useQuery<Task>({
    queryKey: taskId ? queryKeys.task(taskId) : ['tasks', '__none__'],
    queryFn: async ({ signal }) => {
      const res = await tasksApi.get(taskId!, signal);
      return res.task;
    },
    enabled: taskId !== undefined,
  });
}

/**
 * Read-only project member list (§7 GET /projects/:id/members) — needed by the
 * assignee picker (CreateTaskDialog, TaskDetailDrawer). Member *management*
 * mutations are owned by the admin frontend; this hook only reads.
 */
export function useProjectMembers(
  projectId: string | undefined,
): UseQueryResult<ProjectMemberWithUser[]> {
  return useQuery<ProjectMemberWithUser[]>({
    queryKey: projectId
      ? queryKeys.projectMembers(projectId)
      : ['projects', '__none__', 'members'],
    queryFn: async ({ signal }) => {
      const res = await tasksApi.members(projectId!, signal);
      return res.members;
    },
    enabled: projectId !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Optimistic mutation helpers
// ---------------------------------------------------------------------------

/** Snapshot captured in onMutate, restored on error. */
interface BoardSnapshot {
  board: Task[] | undefined;
  task: Task | undefined;
}

/**
 * Patch one task within the cached board array (immutably) and the single-task
 * cache, applying `patch` to the matching task. Returns the prior snapshot.
 */
function applyOptimisticTask(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  taskId: string,
  patch: (task: Task) => Task,
): BoardSnapshot {
  const boardKey = queryKeys.board(projectId);
  const taskKey = queryKeys.task(taskId);

  const board = queryClient.getQueryData<Task[]>(boardKey);
  const task = queryClient.getQueryData<Task>(taskKey);

  if (board) {
    queryClient.setQueryData<Task[]>(
      boardKey,
      board.map((t) => (t.id === taskId ? patch(t) : t)),
    );
  }
  if (task) {
    queryClient.setQueryData<Task>(taskKey, patch(task));
  }

  return { board, task };
}

function restoreSnapshot(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  taskId: string,
  snapshot: BoardSnapshot | undefined,
): void {
  if (!snapshot) return;
  queryClient.setQueryData(queryKeys.board(projectId), snapshot.board);
  queryClient.setQueryData(queryKeys.task(taskId), snapshot.task);
}

function invalidateTask(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  taskId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.board(projectId) });
  // The "全部项目" board (§8) aggregates every visible task, so a mutation issued
  // from a project board must also refresh it (and vice-versa). Idempotent when
  // projectId === ALL_PROJECTS (same key).
  void queryClient.invalidateQueries({ queryKey: queryKeys.allTasks() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.task(taskId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.activities(taskId) });
  // Completing/reopening shifts contribution stats.
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a task via the unified endpoint (§8 POST /tasks). The body carries an
 * optional `projectId`: present → a project task (caller must be a member);
 * absent/null → a no-project (pool) task. No optimistic insert (the server mints
 * id/rank/timestamps); we refetch the affected project board (when scoped) and the
 * "全部项目" board on success.
 */
export function useCreateTask(): UseMutationResult<TaskResponse, Error, CreateTaskInput> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, CreateTaskInput>({
    mutationFn: (body) => tasksApi.create(body),
    onSuccess: (_data, body) => {
      if (body.projectId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.board(body.projectId) });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.allTasks() });
    },
  });
}

/** Variables accepted by the patch mutation: id + partial fields. */
export interface PatchTaskVars {
  taskId: string;
  patch: UpdateTaskInput;
}

/**
 * Patch a task's fields / rank, plus the direct open↔in_progress board moves
 * (§7 PATCH /tasks/:id, lifecycle v2 §3) with an optimistic update. Deliver/review
 * own the pending_review/done transitions, so this never touches completion state.
 */
export function usePatchTask(
  projectId: string,
): UseMutationResult<TaskResponse, Error, PatchTaskVars, BoardSnapshot> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, PatchTaskVars, BoardSnapshot>({
    mutationFn: ({ taskId, patch }) => tasksApi.update(taskId, patch),
    onMutate: async ({ taskId, patch }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board(projectId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });
      // `labelIds` is a write-only id set whose shape differs from the displayed
      // `labels` objects — strip it from the optimistic spread (the server returns
      // the resolved label objects, reconciled on settle).
      const { labelIds: _labelIds, ...optimistic } = patch;
      return applyOptimisticTask(queryClient, projectId, taskId, (task) => {
        const next = { ...task, ...optimistic };
        // Mirror the server's claim-limit recompute: when a patch changes the lower
        // bound without an explicit status move, an open/in_progress task's column
        // depends on whether its claimant count still meets the (new) min. Recompute
        // here so the card doesn't briefly flicker into the wrong column before the
        // server response reconciles.
        if (
          optimistic.status === undefined &&
          optimistic.minClaimants !== undefined &&
          (task.status === 'open' || task.status === 'in_progress')
        ) {
          next.status =
            task.claimants.length >= next.minClaimants ? 'in_progress' : 'open';
        }
        return next;
      });
    },
    onError: (_err, { taskId }, context) => {
      restoreSnapshot(queryClient, projectId, taskId, context);
    },
    onSettled: (_data, _err, { taskId }) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/** Optimistically add a claimant (the current user) to a task's claimant list. */
function addClaimant(task: Task, claimant: TaskClaimant): TaskClaimant[] {
  if (task.claimants.some((c) => c.userId === claimant.userId)) return task.claimants;
  return [...task.claimants, claimant];
}

/**
 * Claim a task (lifecycle v2 §3). Optimistically adds the current user to the
 * claimants set and, if the task was open, moves it to in_progress.
 */
export function useClaimTask(
  projectId: string,
  currentUser?: { id: string; displayName: string; avatarColor: string; hasAvatar: boolean },
): UseMutationResult<TaskResponse, Error, string, BoardSnapshot> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, string, BoardSnapshot>({
    mutationFn: (taskId) => tasksApi.claim(taskId),
    onMutate: async (taskId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board(projectId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });
      return applyOptimisticTask(queryClient, projectId, taskId, (task) => {
        const claimants = currentUser
          ? addClaimant(task, {
              userId: currentUser.id,
              displayName: currentUser.displayName,
              avatarColor: currentUser.avatarColor,
              hasAvatar: currentUser.hasAvatar,
              points: null,
              claimedAt: new Date().toISOString(),
            })
          : task.claimants;
        // Only leave 待认领 once the lower bound is met (claim-limits); below it the
        // task stays open (未达下限) even with some claimants.
        const status =
          task.status === 'open' && claimants.length >= task.minClaimants
            ? 'in_progress'
            : task.status;
        return { ...task, status, claimants };
      });
    },
    onError: (_err, taskId, context) => {
      restoreSnapshot(queryClient, projectId, taskId, context);
    },
    onSettled: (_data, _err, taskId) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/** Variables for release: task id + optional target (defaults to self). */
export interface ReleaseTaskVars {
  taskId: string;
  /** The claimant to remove; omitted means the current user releases themselves. */
  userId?: string;
}

/**
 * Release a claimant from a task (lifecycle v2 §3). Optimistically removes the
 * target from the claimants set; when none remain the task drops back to open.
 */
export function useReleaseTask(
  projectId: string,
  currentUserId?: string,
): UseMutationResult<TaskResponse, Error, ReleaseTaskVars, BoardSnapshot> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, ReleaseTaskVars, BoardSnapshot>({
    mutationFn: ({ taskId, userId }) =>
      tasksApi.release(taskId, userId),
    onMutate: async ({ taskId, userId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board(projectId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });
      const target = userId ?? currentUserId;
      return applyOptimisticTask(queryClient, projectId, taskId, (task) => {
        const claimants = target
          ? task.claimants.filter((c) => c.userId !== target)
          : task.claimants;
        // Drop back to 待认领 with no claimants, or when an in_progress task falls
        // below its lower bound (claim-limits).
        const status =
          claimants.length === 0
            ? 'open'
            : task.status === 'in_progress' && claimants.length < task.minClaimants
              ? 'open'
              : task.status;
        return { ...task, claimants, status };
      });
    },
    onError: (_err, { taskId }, context) => {
      restoreSnapshot(queryClient, projectId, taskId, context);
    },
    onSettled: (_data, _err, { taskId }) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/** Variables for assign: task id + assignee. */
export interface AssignTaskVars {
  taskId: string;
  assigneeId: string;
  /** Optional display fields for an optimistic claimant avatar. */
  assignee?: { displayName: string; avatarColor: string; hasAvatar: boolean };
}

/**
 * Dispatch a task to a member (lifecycle v2 §3, lead/admin only — enforced
 * server-side). Adds the user to the claimants set; open tasks move to in_progress.
 */
export function useAssignTask(
  projectId: string,
): UseMutationResult<TaskResponse, Error, AssignTaskVars, BoardSnapshot> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, AssignTaskVars, BoardSnapshot>({
    mutationFn: ({ taskId, assigneeId }) => tasksApi.assign(taskId, { assigneeId }),
    onMutate: async ({ taskId, assigneeId, assignee }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board(projectId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.task(taskId) });
      return applyOptimisticTask(queryClient, projectId, taskId, (task) => {
        const claimants = assignee
          ? addClaimant(task, {
              userId: assigneeId,
              displayName: assignee.displayName,
              avatarColor: assignee.avatarColor,
              hasAvatar: assignee.hasAvatar,
              points: null,
              claimedAt: new Date().toISOString(),
            })
          : task.claimants;
        // Mirror claim: only advance past 待认领 once the lower bound is met.
        const status =
          task.status === 'open' && claimants.length >= task.minClaimants
            ? 'in_progress'
            : task.status;
        return { ...task, status, claimants };
      });
    },
    onError: (_err, { taskId }, context) => {
      restoreSnapshot(queryClient, projectId, taskId, context);
    },
    onSettled: (_data, _err, { taskId }) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/** Variables for deliver: task id + the allocations payload. */
export interface DeliverTaskVars {
  taskId: string;
  input: DeliverTaskInput;
}

/**
 * Deliver a task for review (lifecycle v2 §3): submit the points split. Moves the
 * task to pending_review server-side; no optimistic mutation (the server validates
 * the split), we just reconcile on settle.
 */
export function useDeliverTask(
  projectId: string,
): UseMutationResult<TaskResponse, Error, DeliverTaskVars> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, DeliverTaskVars>({
    mutationFn: ({ taskId, input }) => tasksApi.deliver(taskId, input),
    onSettled: (_data, _err, { taskId }) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/** Variables for review: task id + decision (+ optional rejection reason). */
export interface ReviewTaskVars {
  taskId: string;
  input: ReviewTaskInput;
}

/**
 * Review a delivered task (lifecycle v2 §3, lead/admin only): approve → done, or
 * reject → in_progress (with an optional reason). Reconciles on settle; completing
 * shifts contribution stats, so the stats queries are invalidated too.
 */
export function useReviewTask(
  projectId: string,
): UseMutationResult<TaskResponse, Error, ReviewTaskVars> {
  const queryClient = useQueryClient();
  return useMutation<TaskResponse, Error, ReviewTaskVars>({
    mutationFn: ({ taskId, input }) => tasksApi.review(taskId, input),
    onSettled: (_data, _err, { taskId }) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}

/**
 * Delete a task (§7 DELETE /tasks/:id). Optimistically removes it from the board.
 */
export function useDeleteTask(
  projectId: string,
): UseMutationResult<void, Error, string, BoardSnapshot> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string, BoardSnapshot>({
    mutationFn: (taskId) => tasksApi.remove(taskId),
    onMutate: async (taskId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.board(projectId) });
      const boardKey = queryKeys.board(projectId);
      const board = queryClient.getQueryData<Task[]>(boardKey);
      const task = queryClient.getQueryData<Task>(queryKeys.task(taskId));
      if (board) {
        queryClient.setQueryData<Task[]>(
          boardKey,
          board.filter((t) => t.id !== taskId),
        );
      }
      return { board, task };
    },
    onError: (_err, taskId, context) => {
      restoreSnapshot(queryClient, projectId, taskId, context);
    },
    onSettled: (_data, _err, taskId) => {
      invalidateTask(queryClient, projectId, taskId);
    },
  });
}
