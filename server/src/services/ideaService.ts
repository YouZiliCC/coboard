import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Idea, IdeaStatus, IdeaWithContext, UserSummary } from 'shared';
import type { Database } from '../db/index.js';
import {
  ideas,
  projects,
  tasks,
  users,
  type IdeaRow,
  type UserRow,
} from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import { publishChange } from './activityService.js';
import { bus, type RealtimeBus } from '../realtime/bus.js';

/**
 * Ideas / inspiration service (§7.1). Owns the data access for ideas posted against
 * a task: listing a task's ideas, posting a new one, the cross-project 灵感区 listing,
 * and the lead/admin adopt/reject mutations. Authorization (project membership,
 * lead/admin) is enforced by the route via guards; this layer only encodes the
 * visibility scope it is handed plus the data access and realtime fan-out.
 *
 * Adopted ideas' `reward_points` feed the contribution-points aggregation in
 * statsService (a user's total points = task-share points + adopted-idea rewards).
 */

// ---------------------------------------------------------------------------
// Row -> wire mapping
// ---------------------------------------------------------------------------

/** Map a user row to the §7.1 public-display summary (no email / password). */
function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    hasAvatar: row.avatarMime != null,
  };
}

/** Map an idea row + its author to the §7.1 `Idea` wire shape. */
function toIdea(row: IdeaRow, author: UserRow): Idea {
  return {
    id: row.id,
    taskId: row.taskId,
    author: toUserSummary(author),
    body: row.body,
    status: row.status,
    rewardPoints: row.rewardPoints,
    adoptedBy: row.adoptedBy,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Load an idea by id or throw 404. */
export async function loadIdeaOrThrow(db: Database, ideaId: string): Promise<IdeaRow> {
  const rows = await db.select().from(ideas).where(eq(ideas.id, ideaId)).limit(1);
  const idea = rows[0];
  if (!idea) {
    throw notFound('想法不存在');
  }
  return idea;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** List a task's ideas (newest first) joined with their authors (§7.1). */
export async function listTaskIdeas(db: Database, taskId: string): Promise<Idea[]> {
  const rows = await db
    .select({ idea: ideas, author: users })
    .from(ideas)
    .innerJoin(users, eq(ideas.authorId, users.id))
    .where(eq(ideas.taskId, taskId))
    .orderBy(desc(ideas.createdAt));
  return rows.map((r) => toIdea(r.idea, r.author));
}

/**
 * Describes which projects the cross-project 灵感区 listing may aggregate over.
 * - `{ kind: 'all' }`                  — every project (global admin).
 * - `{ kind: 'projects', projectIds }` — the explicit set the caller belongs to.
 */
export type IdeaScope =
  | { kind: 'all' }
  | { kind: 'projects'; projectIds: string[] };

/**
 * List the ideas the caller may see in the 灵感区 (§7.1), newest first, each
 * enriched with its task title + owning project (all null for a STANDALONE idea).
 * Optionally filtered by status. Visibility:
 * - STANDALONE ideas (no task) — visible to every logged-in user.
 * - TASK ideas — visible only within the caller's project scope (admins: all).
 *
 * Uses LEFT JOINs to tasks/projects so task-less (standalone) ideas come back with
 * null taskTitle/projectId/projectName.
 */
export async function listVisibleIdeas(
  db: Database,
  scope: IdeaScope,
  status?: IdeaStatus,
): Promise<IdeaWithContext[]> {
  const conditions = [];

  // Scope the TASK ideas to the caller's visible projects; STANDALONE ideas
  // (task_id IS NULL) are always visible. A global admin ('all') sees every idea.
  if (scope.kind === 'projects') {
    const standalone = isNull(ideas.taskId);
    const visibleTaskIdeas =
      scope.projectIds.length === 0
        ? undefined
        : inArray(tasks.projectId, scope.projectIds);
    const predicate = visibleTaskIdeas ? or(standalone, visibleTaskIdeas) : standalone;
    if (predicate) conditions.push(predicate);
  }
  if (status) {
    conditions.push(eq(ideas.status, status));
  }

  const rows = await db
    .select({
      idea: ideas,
      author: users,
      taskTitle: tasks.title,
      projectId: projects.id,
      projectName: projects.name,
    })
    .from(ideas)
    .innerJoin(users, eq(ideas.authorId, users.id))
    .leftJoin(tasks, eq(ideas.taskId, tasks.id))
    .leftJoin(projects, eq(tasks.projectId, projects.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(ideas.createdAt));

  return rows.map((r) => ({
    ...toIdea(r.idea, r.author),
    taskTitle: r.taskTitle,
    projectId: r.projectId,
    projectName: r.projectName,
  }));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface CreateIdeaParams {
  taskId: string;
  /** Owning project, or null for an idea on a no-project (pool) task (§8). */
  projectId: string | null;
  authorId: string;
  body: string;
}

/**
 * Post an idea on a task (§7.1, any project member). Publishes an `idea`-entity
 * realtime event so other clients refresh. Returns the new idea joined with its
 * author.
 */
export async function createIdea(
  db: Database,
  params: CreateIdeaParams,
  realtimeBus: RealtimeBus = bus,
): Promise<Idea> {
  const [inserted] = await db
    .insert(ideas)
    .values({
      taskId: params.taskId,
      authorId: params.authorId,
      body: params.body,
    })
    .returning();

  if (!inserted) {
    // Unreachable: insert..returning yields a row on success.
    throw new Error('创建想法失败：未返回插入行');
  }

  const author = await loadUserOrThrow(db, params.authorId);

  publishChange(
    {
      type: 'idea_created',
      projectId: params.projectId,
      entity: 'idea',
      payload: { ideaId: inserted.id, taskId: params.taskId, authorId: params.authorId },
    },
    realtimeBus,
  );

  return toIdea(inserted, author);
}

export interface CreateStandaloneIdeaParams {
  authorId: string;
  body: string;
}

/**
 * Post a STANDALONE idea in the 灵感区 (no task / project), authored by any logged-in
 * user. Publishes a no-project (global channel) `idea` event so every connected
 * client refreshes the 灵感区. Returns the new idea joined with its author.
 */
export async function createStandaloneIdea(
  db: Database,
  params: CreateStandaloneIdeaParams,
  realtimeBus: RealtimeBus = bus,
): Promise<Idea> {
  const [inserted] = await db
    .insert(ideas)
    .values({
      taskId: null,
      authorId: params.authorId,
      body: params.body,
    })
    .returning();

  if (!inserted) {
    // Unreachable: insert..returning yields a row on success.
    throw new Error('创建想法失败：未返回插入行');
  }

  const author = await loadUserOrThrow(db, params.authorId);

  publishChange(
    {
      type: 'idea_created',
      projectId: null,
      entity: 'idea',
      payload: { ideaId: inserted.id, taskId: null, authorId: params.authorId },
    },
    realtimeBus,
  );

  return toIdea(inserted, author);
}

/**
 * Adopt an idea + grant reward points (§7.1, lead/admin only — enforced by the
 * route). Idempotent-safe: re-adopting an already-adopted idea updates its reward
 * points + adopter. Bumps `updated_at` (the adoption time used by the stats time
 * filter). Publishes an `idea` realtime event AND a `task` event so stats refresh.
 */
export async function adoptIdea(
  db: Database,
  idea: IdeaRow,
  projectId: string | null,
  adopterId: string,
  rewardPoints: number,
  realtimeBus: RealtimeBus = bus,
): Promise<Idea> {
  const [updated] = await db
    .update(ideas)
    .set({
      status: 'adopted',
      rewardPoints,
      adoptedBy: adopterId,
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, idea.id))
    .returning();
  if (!updated) throw notFound('想法不存在');

  const author = await loadUserOrThrow(db, updated.authorId);
  publishIdeaChange(realtimeBus, 'idea_adopted', updated, projectId);
  return toIdea(updated, author);
}

/**
 * Reject an idea (§7.1, lead/admin only). Clears any reward points and marks the
 * idea `rejected`, bumping `updated_at`. Publishes the same events as adopt so the
 * 灵感区 list and stats refresh.
 */
export async function rejectIdea(
  db: Database,
  idea: IdeaRow,
  projectId: string | null,
  reviewerId: string,
  realtimeBus: RealtimeBus = bus,
): Promise<Idea> {
  const [updated] = await db
    .update(ideas)
    .set({
      status: 'rejected',
      rewardPoints: null,
      adoptedBy: reviewerId,
      updatedAt: new Date(),
    })
    .where(eq(ideas.id, idea.id))
    .returning();
  if (!updated) throw notFound('想法不存在');

  const author = await loadUserOrThrow(db, updated.authorId);
  publishIdeaChange(realtimeBus, 'idea_rejected', updated, projectId);
  return toIdea(updated, author);
}

/**
 * Hard-delete an idea (§7.1). Authorization (global admin / author / project lead)
 * is enforced by the route. Publishes the same `idea` + `task` events as
 * adopt/reject so the 灵感区 list and contribution stats refresh — deleting an
 * adopted idea removes its reward points from the author's total.
 */
export async function deleteIdea(
  db: Database,
  idea: IdeaRow,
  projectId: string | null,
  realtimeBus: RealtimeBus = bus,
): Promise<void> {
  await db.delete(ideas).where(eq(ideas.id, idea.id));
  publishIdeaChange(realtimeBus, 'idea_deleted', idea, projectId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Publish both an `idea`-entity event (refresh idea lists) and a `task`-entity
 * event (adopting/rejecting an idea shifts contribution points, so stats refresh).
 */
function publishIdeaChange(
  realtimeBus: RealtimeBus,
  type: string,
  idea: IdeaRow,
  projectId: string | null,
): void {
  publishChange(
    {
      type,
      projectId,
      entity: 'idea',
      payload: { ideaId: idea.id, taskId: idea.taskId, authorId: idea.authorId },
    },
    realtimeBus,
  );
  // Adopting/rejecting changes the author's contribution points (§7.1); the
  // `task` channel is what the client uses to invalidate the `stats` queries.
  publishChange(
    {
      type,
      projectId,
      entity: 'task',
      payload: { taskId: idea.taskId },
    },
    realtimeBus,
  );
}

/** Load a user row by id or throw 404 (the author of a just-written idea). */
async function loadUserOrThrow(db: Database, userId: string): Promise<UserRow> {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user) {
    throw notFound('用户不存在');
  }
  return user;
}
