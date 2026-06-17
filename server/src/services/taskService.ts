import { and, asc, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type {
  AssignTaskInput,
  CreateTaskInput,
  DeliverTaskInput,
  Label,
  ReviewTaskInput,
  Task,
  TaskClaimant,
  TaskStatus,
  UpdateTaskInput,
} from 'shared';
import type { Database } from '../db/index.js';
import {
  projectMembers,
  projects,
  taskClaimants,
  tasks,
  users,
  type TaskClaimantRow,
  type TaskRow,
  type UserRow,
} from '../db/schema.js';
import { conflict, forbidden, notFound, validationError } from '../lib/errors.js';
import { loadLabelsForTasks, setTaskLabels } from './labelService.js';
import {
  canEditNoProjectTask,
  canEditTask,
  canReviewNoProjectTask,
  requireAuth,
  requireProjectLead,
  requireProjectMember,
  requireTaskVisibility,
  type TaskAccessContext,
} from '../lib/guards.js';
import type { FastifyRequest } from 'fastify';
import { publishChange, recordActivity } from './activityService.js';
import type { RealtimeBus } from '../realtime/bus.js';

/**
 * Task / board domain service (§6.1, §6.2, §6.5). Owns all task mutations: create,
 * edit (fields/status/rank), claim, release, assign, delete. Every mutation records
 * an activity AND publishes a `task` realtime event so SSE clients refresh their
 * board (§6.5). Authorization is delegated to `lib/guards.ts` (§6.3).
 *
 * `rank` is a lexicographic text key for intra-column ordering (§5/§6.1): tasks in
 * a column are sorted by `rank ASC, created_at ASC`. New tasks are appended after
 * the current last rank in their target column.
 */

// ---------------------------------------------------------------------------
// Rank: fractional/lexicographic ordering key (§6.1)
// ---------------------------------------------------------------------------

/**
 * Ordered alphabet for rank digits. Lexicographic string comparison over this
 * alphabet matches the intended order. We use a midpoint scheme so a rank can
 * always be generated strictly between any two neighbours without re-indexing.
 */
const RANK_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const RANK_BASE = RANK_DIGITS.length;
const RANK_MIN = 0;
const RANK_MAX = RANK_BASE - 1;
/** Default rank used for the very first task in an empty column (~midpoint). */
const RANK_INITIAL = RANK_DIGITS[Math.floor(RANK_BASE / 2)] as string;

/** Digit value of the char at `index` in `s` (defaults: low for missing). */
function digitAt(s: string, index: number, fallback: number): number {
  if (index >= s.length) return fallback;
  const idx = RANK_DIGITS.indexOf(s.charAt(index));
  return idx < 0 ? fallback : idx;
}

/** The rank character for a digit value (guaranteed in-range). */
function digitChar(value: number): string {
  const clamped = Math.max(RANK_MIN, Math.min(RANK_MAX, value));
  return RANK_DIGITS.charAt(clamped);
}

/**
 * Generate a rank that sorts strictly between `before` and `after`. Either bound
 * may be null (open-ended). The result is a string over RANK_DIGITS that compares
 * lexicographically between the two — a simplified fractional-index scheme that
 * never needs a global re-index.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before === null && after === null) return RANK_INITIAL;

  let prefix = '';
  let i = 0;
  for (;;) {
    // Missing digits: treat `before` as padded with the min digit, `after` as
    // padded with one past the max (so an open upper bound has room above).
    const b = before === null ? RANK_MIN : digitAt(before, i, RANK_MIN);
    const a = after === null ? RANK_BASE : digitAt(after, i, RANK_BASE);

    if (a - b > 1) {
      // Room for a midpoint digit strictly between the two bounds.
      return prefix + digitChar(Math.floor((a + b) / 2));
    }

    // Bounds are adjacent (or equal) at this position: keep the lower digit and
    // descend, widening the upper bound to "open" below this shared prefix.
    prefix += digitChar(b);
    i += 1;
    if (after !== null && i >= after.length) {
      // We have matched all of `after`; below it the upper bound is open.
      after = null;
    }
  }
}

/**
 * Compute a rank that appends after the last task in the given column. The column is
 * scoped to a project, or to the shared no-project pool when `projectId` is null (§8).
 */
async function nextRankForColumn(
  db: Database,
  projectId: string | null,
  status: TaskStatus,
): Promise<string> {
  const projectFilter =
    projectId === null ? isNull(tasks.projectId) : eq(tasks.projectId, projectId);
  const rows = await db
    .select({ rank: tasks.rank })
    .from(tasks)
    .where(and(projectFilter, eq(tasks.status, status)))
    .orderBy(desc(tasks.rank))
    .limit(1);
  const last = rows[0]?.rank ?? null;
  return rankBetween(last, null);
}

// ---------------------------------------------------------------------------
// Row → wire mapping (§5 entity shape, ISO timestamps)
// ---------------------------------------------------------------------------

/**
 * A claimant row joined with the user's display fields, as loaded for serialization
 * (lifecycle v2 §2). The wire shape carries only the display summary, not the full
 * user row (§schema taskClaimantSchema).
 */
export interface ClaimantWithUser {
  row: TaskClaimantRow;
  user: Pick<UserRow, 'id' | 'displayName' | 'avatarColor' | 'avatarMime'>;
}

/** Serialize one claimant join to the shared `TaskClaimant` wire shape. */
function serializeClaimant(c: ClaimantWithUser): TaskClaimant {
  return {
    userId: c.user.id,
    displayName: c.user.displayName,
    avatarColor: c.user.avatarColor,
    hasAvatar: c.user.avatarMime != null,
    points: c.row.points,
    claimedAt: c.row.claimedAt.toISOString(),
  };
}

/** Lightweight owning-project context embedded in a serialized task (§8). */
export interface TaskProjectContext {
  name: string;
  key: string;
}

/**
 * Serialize a persisted task row to the shared `Task` wire shape (lifecycle v2 §2;
 * no-project tasks §8). Claimants are sorted by claim time so avatar stacking is
 * stable. The deprecated single-assignee columns are never surfaced. `project`
 * carries the owning project's name/key for the all-projects view; pass null for a
 * no-project (pool) task — `projectName`/`projectKey` then serialize to null.
 */
export function serializeTask(
  row: TaskRow,
  claimants: ClaimantWithUser[] = [],
  project: TaskProjectContext | null = null,
  labels: Label[] = [],
): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    projectName: project ? project.name : null,
    projectKey: project ? project.key : null,
    title: row.title,
    description: row.description,
    status: row.status,
    points: row.points,
    priority: row.priority,
    minClaimants: row.minClaimants,
    maxClaimants: row.maxClaimants,
    dueDate: row.dueDate,
    createdBy: row.createdBy,
    rank: row.rank,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    deliveredBy: row.deliveredBy,
    reviewedBy: row.reviewedBy,
    claimants: [...claimants]
      .sort((a, b) => a.row.claimedAt.getTime() - b.row.claimedAt.getTime())
      .map(serializeClaimant),
    labels,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Load the claimants (joined with their users) for a set of task ids. */
async function loadClaimantsForTasks(
  db: Database,
  taskIds: string[],
): Promise<Map<string, ClaimantWithUser[]>> {
  const byTask = new Map<string, ClaimantWithUser[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select({
      claimant: taskClaimants,
      userId: users.id,
      displayName: users.displayName,
      avatarColor: users.avatarColor,
      avatarMime: users.avatarMime,
    })
    .from(taskClaimants)
    .innerJoin(users, eq(users.id, taskClaimants.userId))
    .where(inArray(taskClaimants.taskId, taskIds));
  for (const r of rows) {
    const list = byTask.get(r.claimant.taskId) ?? [];
    list.push({
      row: r.claimant,
      user: {
        id: r.userId,
        displayName: r.displayName,
        avatarColor: r.avatarColor,
        avatarMime: r.avatarMime,
      },
    });
    byTask.set(r.claimant.taskId, list);
  }
  return byTask;
}

/** Load a task's owning-project context (name/key), or null for a pool task (§8). */
async function loadProjectContext(
  db: Database,
  projectId: string | null,
): Promise<TaskProjectContext | null> {
  if (projectId === null) return null;
  const rows = await db
    .select({ name: projects.name, key: projects.key })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const row = rows[0];
  return row ? { name: row.name, key: row.key } : null;
}

/** Load + serialize a single task with its claimants, project context, and labels. */
async function serializeTaskById(db: Database, row: TaskRow): Promise<Task> {
  const byTask = await loadClaimantsForTasks(db, [row.id]);
  const project = await loadProjectContext(db, row.projectId);
  const labelsByTask = await loadLabelsForTasks(db, [row.id]);
  return serializeTask(row, byTask.get(row.id) ?? [], project, labelsByTask.get(row.id) ?? []);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Load a task row by id or throw 404. */
async function loadTask(db: Database, taskId: string): Promise<TaskRow> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const task = rows[0];
  if (!task) {
    throw notFound('任务不存在');
  }
  return task;
}

/**
 * The task row plus the caller's resolved {@link TaskAccessContext} (§6.3 / §8).
 */
interface TaskAccess extends TaskAccessContext {
  task: TaskRow;
}

/**
 * Load a task and resolve who the caller is relative to it, enforcing visibility
 * (§6.3 / §8): project tasks require membership (403 otherwise); no-project (pool)
 * tasks are visible to every authenticated user. Delegates to the shared guard so the
 * pool/project semantics stay in one place.
 *
 * Note `isLead` here is the lead-equivalent manage flag (project lead/admin, or the
 * creator/admin of a pool task), per {@link requireTaskVisibility}.
 */
async function loadTaskAccess(
  db: Database,
  request: FastifyRequest,
  taskId: string,
): Promise<TaskAccess> {
  const task = await loadTask(db, taskId);
  const access = await requireTaskVisibility(db, request, task);
  return { task, ...access };
}

/**
 * Publish a `task` realtime event for board invalidation (§6.5). `projectId` is the
 * task's project, or null for a no-project (pool) task — a null fans out to every
 * connected user via the global channel (§8).
 */
function publishTaskChange(
  bus: RealtimeBus,
  type: string,
  task: TaskRow,
): void {
  publishChange(
    {
      type,
      projectId: task.projectId,
      entity: 'task',
      payload: { taskId: task.id, status: task.status },
    },
    bus,
  );
}

// ---------------------------------------------------------------------------
// Board read (§7 GET /projects/:id/tasks)
// ---------------------------------------------------------------------------

/**
 * Return all tasks for a project, ordered for the board (by rank then creation).
 * The client groups by `status` into the four fixed columns (§6.1). Every task shares
 * the same owning project, so its name/key is loaded once and stamped onto each task.
 */
export async function listBoardTasks(db: Database, projectId: string): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.projectId, projectId))
    .orderBy(asc(tasks.rank), asc(tasks.createdAt));
  const byTask = await loadClaimantsForTasks(
    db,
    rows.map((r) => r.id),
  );
  const project = await loadProjectContext(db, projectId);
  const labelsByTask = await loadLabelsForTasks(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) =>
    serializeTask(row, byTask.get(row.id) ?? [], project, labelsByTask.get(row.id) ?? []),
  );
}

// ---------------------------------------------------------------------------
// All-projects board read (§8 GET /tasks/all)
// ---------------------------------------------------------------------------

/**
 * Every task the caller can see (§8): tasks in the projects they belong to (a global
 * admin sees every project) UNION all no-project (task-pool) tasks. Each task is
 * enriched with its owning-project name/key (null for pool tasks) and its claimants.
 * Ordered by rank then creation, like the per-project board. Avoids N+1 by batching
 * the claimant and project lookups.
 */
export async function listAllVisibleTasks(
  db: Database,
  user: UserRow,
): Promise<Task[]> {
  // Visible project set: every project for an admin, else the caller's memberships.
  let visibleProjectIds: string[];
  if (user.role === 'admin') {
    const rows = await db.select({ id: projects.id }).from(projects);
    visibleProjectIds = rows.map((r) => r.id);
  } else {
    const rows = await db
      .select({ projectId: projectMembers.projectId })
      .from(projectMembers)
      .where(eq(projectMembers.userId, user.id));
    visibleProjectIds = rows.map((r) => r.projectId);
  }

  // No-project (pool) tasks are always visible; project tasks only in-scope ones.
  const where =
    visibleProjectIds.length === 0
      ? isNull(tasks.projectId)
      : or(isNull(tasks.projectId), inArray(tasks.projectId, visibleProjectIds));

  const rows = await db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.rank), asc(tasks.createdAt));

  const byTask = await loadClaimantsForTasks(
    db,
    rows.map((r) => r.id),
  );

  // Batch-load project context (name/key) for every distinct owning project.
  const projectIds = [
    ...new Set(rows.map((r) => r.projectId).filter((id): id is string => id !== null)),
  ];
  const projectById = new Map<string, TaskProjectContext>();
  if (projectIds.length > 0) {
    const projectRows = await db
      .select({ id: projects.id, name: projects.name, key: projects.key })
      .from(projects)
      .where(inArray(projects.id, projectIds));
    for (const p of projectRows) {
      projectById.set(p.id, { name: p.name, key: p.key });
    }
  }

  const labelsByTask = await loadLabelsForTasks(
    db,
    rows.map((r) => r.id),
  );

  return rows.map((row) =>
    serializeTask(
      row,
      byTask.get(row.id) ?? [],
      row.projectId === null ? null : projectById.get(row.projectId) ?? null,
      labelsByTask.get(row.id) ?? [],
    ),
  );
}

// ---------------------------------------------------------------------------
// Create (§6.1 / §6.2 POST /projects/:id/tasks)
// ---------------------------------------------------------------------------

/**
 * Create a task (§6.1/§6.2; no-project tasks §8). `projectId` selects the owning
 * project, or null to create a no-project (task-pool) task. A project task requires
 * the caller to be a project member (existing guard); a pool task may be created by
 * any authenticated user. Defaults to `open` with no claimants; if `assigneeId` is
 * supplied the task is dispatched on creation → `in_progress` with that user added as
 * a claimant (lifecycle v2 §2/§3). Records `created` (+ `assigned` when dispatched)
 * and publishes a task event.
 */
export async function createTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  projectId: string | null,
  input: CreateTaskInput,
): Promise<Task> {
  // Project task → member-only; no-project (pool) task → any authenticated user (§8).
  const actor =
    projectId === null
      ? requireAuth(request)
      : (await requireProjectMember(db, request, projectId)).user;

  const minClaimants = input.minClaimants ?? 1;
  const maxClaimants = input.maxClaimants ?? null;
  // Dispatching adds exactly one claimant; the task only reaches 进行中 if that one
  // claimant already meets the lower bound (min === 1), else it waits in 待认领.
  const dispatched = input.assigneeId != null;
  const status: TaskStatus = dispatched ? poolStatusFor(1, minClaimants) : 'open';
  const rank = await nextRankForColumn(db, projectId, status);

  const [created] = await db
    .insert(tasks)
    .values({
      projectId,
      title: input.title,
      description: input.description ?? null,
      status,
      points: input.points ?? null,
      priority: input.priority,
      minClaimants,
      maxClaimants,
      dueDate: input.dueDate ?? null,
      createdBy: actor.id,
      rank,
    })
    .returning();

  if (!created) {
    throw new Error('创建任务失败：未返回插入行');
  }

  if (dispatched && input.assigneeId) {
    await db
      .insert(taskClaimants)
      .values({ taskId: created.id, userId: input.assigneeId })
      .onConflictDoNothing();
  }

  // Apply the optional label set (task-labels). The caller created the task, so
  // they may set its labels (creation implies edit rights on the new task).
  if (input.labelIds !== undefined) {
    await setTaskLabels(db, created.id, input.labelIds);
  }

  await recordActivity(db, {
    taskId: created.id,
    projectId,
    actorId: actor.id,
    type: 'created',
    meta: { title: created.title },
  }, bus);

  if (dispatched) {
    await recordActivity(db, {
      taskId: created.id,
      projectId,
      actorId: actor.id,
      type: 'assigned',
      meta: { assigneeId: input.assigneeId },
    }, bus);
  }

  publishTaskChange(bus, 'created', created);
  return serializeTaskById(db, created);
}

// ---------------------------------------------------------------------------
// Read single (§7 GET /tasks/:id)
// ---------------------------------------------------------------------------

export async function getTask(
  db: Database,
  request: FastifyRequest,
  taskId: string,
): Promise<Task> {
  const { task } = await loadTaskAccess(db, request, taskId);
  return serializeTaskById(db, task);
}

// ---------------------------------------------------------------------------
// Update fields / status / rank (§6.1 PATCH /tasks/:id)
// ---------------------------------------------------------------------------

/**
 * Patch a task's fields / rank, plus the direct `open↔in_progress` status moves
 * used by board drag (lifecycle v2 §3). Deliver/review own all transitions into
 * `pending_review`/`done`, so PATCH rejects any status target other than `open`
 * or `in_progress` (and only from `open`/`in_progress`). Records `status_changed`
 * for a status move, else `updated`. Requires edit permission on the task (§6.3).
 */
export async function updateTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
  input: UpdateTaskInput,
): Promise<Task> {
  const { task, user, membership } = await loadTaskAccess(db, request, taskId);
  // Project task → creator/lead/admin; no-project task → creator or admin (§8).
  const canEdit = membership
    ? canEditTask(membership, task)
    : canEditNoProjectTask(user, task);
  if (!canEdit) {
    throw forbidden('只能编辑自己创建或负责的任务');
  }
  const actor = user;

  const patch: Partial<TaskRow> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.points !== undefined) patch.points = input.points;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (input.rank !== undefined) patch.rank = input.rank;

  // Claim-count limits (claim-limits): merge requested bounds with the stored ones,
  // re-validate min <= max across the merge, then persist whichever were provided.
  const newMin = input.minClaimants ?? task.minClaimants;
  const newMax = input.maxClaimants !== undefined ? input.maxClaimants : task.maxClaimants;
  if (newMax != null && newMax < newMin) {
    throw validationError('领取人数上限不能小于下限');
  }
  if (input.minClaimants !== undefined) patch.minClaimants = input.minClaimants;
  if (input.maxClaimants !== undefined) patch.maxClaimants = input.maxClaimants;

  // Resolve the final status. An explicit open↔in_progress move is allowed, but a
  // move into 进行中 must still meet the lower bound (claim-limits) — an under-min
  // task must stay in 待认领. When no explicit move is requested but the lower bound
  // changed, recompute the active-pool status so lowering the bound can advance an
  // over-min task and raising it drops an under-min task back to 待认领.
  let targetStatus: TaskStatus = task.status;
  if (input.status !== undefined && input.status !== task.status) {
    const to = input.status;
    // Only the direct open↔in_progress moves are allowed via PATCH; deliver/review
    // own the pending_review/done transitions (§3).
    const allowed =
      (task.status === 'open' || task.status === 'in_progress') &&
      (to === 'open' || to === 'in_progress');
    if (!allowed) {
      throw validationError('该状态变更需通过交付 / 审阅完成');
    }
    if (to === 'in_progress') {
      const count = (await loadClaimantIds(db, taskId)).length;
      if (count < newMin) {
        throw validationError('未达领取人数下限，无法进入「进行中」');
      }
    }
    targetStatus = to;
  } else if (
    input.minClaimants !== undefined &&
    (task.status === 'open' || task.status === 'in_progress')
  ) {
    const count = (await loadClaimantIds(db, taskId)).length;
    targetStatus = poolStatusFor(count, newMin);
  }
  const statusChanged = targetStatus !== task.status;
  if (statusChanged) patch.status = targetStatus;

  // Apply the optional label REPLACE set (task-labels). Permitted to anyone who may
  // edit the task — the same gate already enforced above.
  if (input.labelIds !== undefined) {
    await setTaskLabels(db, taskId, input.labelIds);
  }

  // A patch may carry only `labelIds` (no scalar fields); skip the empty UPDATE then.
  const updated =
    Object.keys(patch).length > 0
      ? (
          await db.update(tasks).set(patch).where(eq(tasks.id, taskId)).returning()
        )[0]
      : task;

  if (!updated) {
    throw notFound('任务不存在');
  }

  if (statusChanged) {
    await recordActivity(db, {
      taskId,
      projectId: updated.projectId,
      actorId: actor.id,
      type: 'status_changed',
      meta: { from: task.status, to: targetStatus },
    }, bus);
  } else {
    // Field-only edit (incl. rank reorder and/or a label set change).
    const fields = Object.keys(patch);
    if (input.labelIds !== undefined) fields.push('labelIds');
    await recordActivity(db, {
      taskId,
      projectId: updated.projectId,
      actorId: actor.id,
      type: 'updated',
      meta: { fields },
    }, bus);
  }

  publishTaskChange(bus, statusChanged ? 'status_changed' : 'updated', updated);
  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Claim (§6.2 POST /tasks/:id/claim)
// ---------------------------------------------------------------------------

/** The set of user ids currently claiming a task. */
async function loadClaimantIds(db: Database, taskId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: taskClaimants.userId })
    .from(taskClaimants)
    .where(eq(taskClaimants.taskId, taskId));
  return rows.map((r) => r.userId);
}

/**
 * The active-pool status (claim-limits feature): a task with at least `minClaimants`
 * claimants is `in_progress`; below the floor it stays `open` (待认领, 未达下限). Only
 * applies while a task is in the claimable pool — deliver/review own the later states.
 */
function poolStatusFor(count: number, minClaimants: number): 'open' | 'in_progress' {
  return count >= minClaimants ? 'in_progress' : 'open';
}

/**
 * Claim a task (lifecycle v2 §3; no-project tasks §8): add the caller to the
 * claimants set (idempotent) and, if the task is still `open`, move it to
 * `in_progress`. Any project member may claim a project task; any authenticated user
 * may claim a no-project (pool) task. A delivered/done task cannot be claimed.
 */
export async function claimTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
): Promise<Task> {
  const { task, user: actor } = await loadTaskAccess(db, request, taskId);

  if (task.status !== 'open' && task.status !== 'in_progress') {
    throw conflict('该状态的任务不可认领');
  }

  // Enforce the upper bound (claim-limits): a non-claimant cannot join once the
  // claimant count has reached `maxClaimants` (null = unlimited). Re-claiming is
  // idempotent and never blocked.
  const claimantIds = await loadClaimantIds(db, taskId);
  const alreadyClaimant = claimantIds.includes(actor.id);
  if (!alreadyClaimant && task.maxClaimants != null && claimantIds.length >= task.maxClaimants) {
    throw conflict('已达领取人数上限');
  }

  // Idempotent add to the claimants set.
  const inserted = await db
    .insert(taskClaimants)
    .values({ taskId, userId: actor.id })
    .onConflictDoNothing()
    .returning();

  let updated = task;
  if (task.status === 'open') {
    // Only leave 待认领 once the lower bound is met; below it the task stays open
    // (未达下限) even though it now has some claimants (claim-limits).
    const count = claimantIds.length + inserted.length;
    const nextStatus = poolStatusFor(count, task.minClaimants);
    if (nextStatus !== task.status) {
      const [row] = await db
        .update(tasks)
        .set({ status: nextStatus })
        .where(eq(tasks.id, taskId))
        .returning();
      if (row) updated = row;
    }
  }

  // Only record activity / fan out when the caller was newly added.
  if (inserted.length > 0) {
    await recordActivity(db, {
      taskId,
      projectId: task.projectId,
      actorId: actor.id,
      type: 'claimed',
      meta: {},
    }, bus);
    publishTaskChange(bus, 'claimed', updated);
  }

  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Release (§3 POST /tasks/:id/release)
// ---------------------------------------------------------------------------

/**
 * Release a task (lifecycle v2 §3; no-project tasks §8): remove a claimant from the
 * set. The caller may always remove themselves. Removing another claimant requires a
 * lead/admin on a project task, or the creator/admin on a no-project (pool) task. If
 * no claimants remain the task returns to `open`.
 */
export async function releaseTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
  targetUserId?: string,
): Promise<Task> {
  const { task, user: actor, isLead } = await loadTaskAccess(db, request, taskId);

  // Releasing only makes sense while a task is in the claimable pool. Blocking it
  // for pending_review/done keeps the claimant set (and the locked points / deliver
  // state) intact for review/contribution, and prevents reopening a finished task.
  if (task.status !== 'open' && task.status !== 'in_progress') {
    throw conflict('只有待认领或进行中的任务可以退出认领');
  }

  // Default target is the caller (self-release). Removing someone else needs the
  // lead-equivalent: project lead/admin, or the creator/admin of a pool task (§8) —
  // both encoded in `isLead` by requireTaskVisibility.
  const userId = targetUserId ?? actor.id;
  if (userId !== actor.id && !isLead) {
    throw forbidden('没有权限移除该认领者');
  }

  const removed = await db
    .delete(taskClaimants)
    .where(and(eq(taskClaimants.taskId, taskId), eq(taskClaimants.userId, userId)))
    .returning();

  if (removed.length === 0) {
    throw conflict('该用户不是认领者');
  }

  // Recompute the pool status (claim-limits). With no claimants left the task drops
  // back to 待认领 and any deliver state is cleared. While `in_progress`, dropping
  // below the lower bound also returns it to 待认领 (未达下限). Post-delivery states
  // (pending_review/done) are left alone — only the active pool re-balances here.
  const remaining = await loadClaimantIds(db, taskId);
  let updated = task;
  if (remaining.length === 0) {
    const [row] = await db
      .update(tasks)
      .set({ status: 'open', deliveredAt: null, deliveredBy: null })
      .where(eq(tasks.id, taskId))
      .returning();
    if (row) updated = row;
  } else if (task.status === 'in_progress' && remaining.length < task.minClaimants) {
    const [row] = await db
      .update(tasks)
      .set({ status: 'open' })
      .where(eq(tasks.id, taskId))
      .returning();
    if (row) updated = row;
  }

  await recordActivity(db, {
    taskId,
    projectId: task.projectId,
    actorId: actor.id,
    type: 'released',
    meta: { userId },
  }, bus);

  publishTaskChange(bus, 'released', updated);
  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Assign / dispatch (§3 POST /tasks/:id/assign)
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a worker (lifecycle v2 §3; no-project tasks §8): add the user to
 * the claimants set and, if the task is still `open`, move it to `in_progress`.
 * Permitted to a project lead/admin on a project task, or the creator/admin on a
 * no-project (pool) task. Records `assigned`.
 */
export async function assignTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
  input: AssignTaskInput,
): Promise<Task> {
  const task = await loadTask(db, taskId);

  let actor: UserRow;
  if (task.projectId === null) {
    // No-project (pool) task → creator or global admin (§8).
    actor = requireAuth(request);
    if (!canEditNoProjectTask(actor, task)) {
      throw forbidden('只有任务创建者或管理员可以派发');
    }
  } else {
    // Project task → lead/admin only, via the project lead guard.
    actor = (await requireProjectLead(db, request, task.projectId)).user;
  }

  if (task.status === 'done') {
    throw conflict('已完成的任务不能再派发');
  }

  // Dispatch also respects the upper bound (claim-limits): can't add a new claimant
  // past `maxClaimants`. Re-assigning an existing claimant is idempotent.
  const claimantIds = await loadClaimantIds(db, taskId);
  const alreadyClaimant = claimantIds.includes(input.assigneeId);
  if (!alreadyClaimant && task.maxClaimants != null && claimantIds.length >= task.maxClaimants) {
    throw conflict('已达领取人数上限');
  }

  const inserted = await db
    .insert(taskClaimants)
    .values({ taskId, userId: input.assigneeId })
    .onConflictDoNothing()
    .returning();

  let updated = task;
  if (task.status === 'open') {
    const count = claimantIds.length + inserted.length;
    const nextStatus = poolStatusFor(count, task.minClaimants);
    if (nextStatus !== task.status) {
      const [row] = await db
        .update(tasks)
        .set({ status: nextStatus })
        .where(eq(tasks.id, taskId))
        .returning();
      if (row) updated = row;
    }
  }

  if (inserted.length > 0) {
    await recordActivity(db, {
      taskId,
      projectId: task.projectId,
      actorId: actor.id,
      type: 'assigned',
      meta: { assigneeId: input.assigneeId },
    }, bus);
    publishTaskChange(bus, 'assigned', updated);
  }

  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Deliver (§3 POST /tasks/:id/deliver)
// ---------------------------------------------------------------------------

/**
 * Deliver a task for review (lifecycle v2 §3). Allowed to a claimant or a lead/admin
 * while the task is `in_progress`. `allocations` must cover exactly the current
 * claimant set; their points sum must equal `tasks.points` (or `totalPoints` when
 * the task has no points yet — which is then persisted). On success the task moves
 * to `pending_review`, `delivered_at`/`delivered_by` are set, and each claimant's
 * share is written. Records `delivered`.
 */
export async function deliverTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
  input: DeliverTaskInput,
): Promise<Task> {
  const { task, user: actor, isLead } = await loadTaskAccess(db, request, taskId);

  if (task.status !== 'in_progress') {
    throw conflict('只有进行中的任务可以交付');
  }

  const claimantIds = await loadClaimantIds(db, taskId);
  if (claimantIds.length === 0) {
    throw validationError('任务还没有认领者，无法交付');
  }

  // A claimant may deliver; otherwise the lead-equivalent manager (project lead/admin,
  // or the creator/admin of a pool task, §8 — encoded in `isLead`) may deliver on the
  // team's behalf.
  const isClaimant = claimantIds.includes(actor.id);
  if (!isClaimant && !isLead) {
    throw forbidden('只有认领者或负责人可以交付');
  }

  // Allocations must cover exactly the current claimant set, one entry per user.
  const claimantSet = new Set(claimantIds);
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (!claimantSet.has(a.userId)) {
      throw validationError('分配中包含非认领者');
    }
    if (seen.has(a.userId)) {
      throw validationError('每个认领者只能分配一次');
    }
    seen.add(a.userId);
  }
  if (seen.size !== claimantSet.size) {
    throw validationError('分配必须覆盖所有认领者');
  }

  const sum = input.allocations.reduce((acc, a) => acc + a.points, 0);
  // Target total: the task points, or the supplied totalPoints when unset.
  let total: number;
  if (task.points != null) {
    total = task.points;
  } else {
    if (input.totalPoints == null) {
      throw validationError('任务没有点数，请提供总点数');
    }
    total = input.totalPoints;
  }
  if (sum !== total) {
    throw validationError('分配点数之和必须等于总点数');
  }

  // Persist: task → pending_review + deliver metadata (+ points if it was unset).
  const taskPatch: Partial<TaskRow> = {
    status: 'pending_review',
    deliveredAt: new Date(),
    deliveredBy: actor.id,
  };
  if (task.points == null) taskPatch.points = total;

  const [updated] = await db
    .update(tasks)
    .set(taskPatch)
    .where(eq(tasks.id, taskId))
    .returning();
  if (!updated) {
    throw notFound('任务不存在');
  }

  // Write each claimant's share.
  for (const a of input.allocations) {
    await db
      .update(taskClaimants)
      .set({ points: a.points })
      .where(and(eq(taskClaimants.taskId, taskId), eq(taskClaimants.userId, a.userId)));
  }

  await recordActivity(db, {
    taskId,
    projectId: task.projectId,
    actorId: actor.id,
    type: 'delivered',
    meta: { totalPoints: total },
  }, bus);

  publishTaskChange(bus, 'delivered', updated);
  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Review (§3 POST /tasks/:id/review)
// ---------------------------------------------------------------------------

/**
 * Review a delivered task (lifecycle v2 §3; task must be `pending_review`). Permitted
 * to a project lead/admin on a project task, or the task creator/admin on a no-project
 * (pool) task (§8 — pool tasks have no project lead). `approve` → `done` with
 * `completed_at`/`reviewed_by` set (the shares stay locked) and records `completed`.
 * `reject` → `in_progress`, clears `delivered_at`/`delivered_by` and every claimant's
 * points, sets `reviewed_by`, and records `rejected` (the optional `comment` is the
 * rejection reason).
 */
export async function reviewTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
  input: ReviewTaskInput,
): Promise<Task> {
  const task = await loadTask(db, taskId);

  let actor: UserRow;
  if (task.projectId === null) {
    // No-project (pool) task → creator or global admin (§8).
    actor = requireAuth(request);
    if (!canReviewNoProjectTask(actor, task)) {
      throw forbidden('只有任务创建者或管理员可以审阅');
    }
  } else {
    // Project task → lead/admin only, via the project lead guard.
    actor = (await requireProjectLead(db, request, task.projectId)).user;
  }

  if (task.status !== 'pending_review') {
    throw conflict('只有待审阅的任务可以审阅');
  }

  if (input.decision === 'approve') {
    const [updated] = await db
      .update(tasks)
      .set({ status: 'done', completedAt: new Date(), reviewedBy: actor.id })
      .where(eq(tasks.id, taskId))
      .returning();
    if (!updated) throw notFound('任务不存在');

    await recordActivity(db, {
      taskId,
      projectId: task.projectId,
      actorId: actor.id,
      type: 'completed',
      meta: {},
    }, bus);

    publishTaskChange(bus, 'completed', updated);
    return serializeTaskById(db, updated);
  }

  // reject → back to the claimable pool; clear deliver state + each claimant's share.
  // Choose open vs in_progress by the lower bound (claim-limits) so a task that no
  // longer meets minClaimants returns to 待认领 (未达下限) rather than 进行中.
  const rejectCount = (await loadClaimantIds(db, taskId)).length;
  const [updated] = await db
    .update(tasks)
    .set({
      status: poolStatusFor(rejectCount, task.minClaimants),
      deliveredAt: null,
      deliveredBy: null,
      reviewedBy: actor.id,
    })
    .where(eq(tasks.id, taskId))
    .returning();
  if (!updated) throw notFound('任务不存在');

  await db
    .update(taskClaimants)
    .set({ points: null })
    .where(eq(taskClaimants.taskId, taskId));

  await recordActivity(db, {
    taskId,
    projectId: task.projectId,
    actorId: actor.id,
    type: 'rejected',
    meta: input.comment ? { comment: input.comment } : {},
  }, bus);

  publishTaskChange(bus, 'rejected', updated);
  return serializeTaskById(db, updated);
}

// ---------------------------------------------------------------------------
// Delete (§6.3 DELETE /tasks/:id)
// ---------------------------------------------------------------------------

/**
 * Delete a task. For a project task: creator, project lead, or global admin (§6.3).
 * For a no-project (pool) task: creator or global admin (§8). Publishes a deletion
 * event; no activity row is recorded since the task (and its activities) cease to
 * exist.
 */
export async function deleteTask(
  db: Database,
  bus: RealtimeBus,
  request: FastifyRequest,
  taskId: string,
): Promise<void> {
  const { task, user, membership } = await loadTaskAccess(db, request, taskId);
  const canDelete = membership
    ? canEditTask(membership, task)
    : canEditNoProjectTask(user, task);
  if (!canDelete) {
    throw forbidden('只能删除自己创建或负责的任务');
  }

  await db.delete(tasks).where(eq(tasks.id, taskId));

  publishChange(
    {
      type: 'deleted',
      projectId: task.projectId,
      entity: 'task',
      payload: { taskId: task.id },
    },
    bus,
  );
}
