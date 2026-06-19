import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { ProjectRole } from 'shared';
import type { Database } from '../db/index.js';
import {
  projectMembers,
  projects,
  type ProjectRow,
  type TaskRow,
  type UserRow,
} from '../db/schema.js';
import { forbidden, notFound, unauthorized } from './errors.js';

/**
 * Centralized authorization (§6.3). Every write path must pass through a guard;
 * the front-end only hides actions cosmetically. Guards throw AppError (401/403/
 * 404) and otherwise return the resolved context the handler needs.
 */

/** Require an authenticated, active user. Returns the user row. */
export function requireAuth(request: FastifyRequest): UserRow {
  if (!request.user) {
    throw unauthorized();
  }
  return request.user;
}

/** Require a global admin. */
export function requireAdmin(request: FastifyRequest): UserRow {
  const user = requireAuth(request);
  if (user.role !== 'admin') {
    throw forbidden('需要管理员权限');
  }
  return user;
}

export interface ProjectMembership {
  user: UserRow;
  project: ProjectRow;
  /** The user's role in this project; admins are treated as 'lead'. */
  projectRole: ProjectRole;
  /** True if the user is a real member row (false for admins acting cross-project). */
  isMemberRow: boolean;
}

/** Load a project by id or throw 404. */
async function loadProject(db: Database, projectId: string): Promise<ProjectRow> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  const project = rows[0];
  if (!project) {
    throw notFound('项目不存在');
  }
  return project;
}

/**
 * Resolve a user's membership in a project. Global admins are granted lead-level
 * access to every project even without a membership row (§6.3). Throws 403 for
 * non-admins who are not members (non-members must not even see the project).
 */
export async function requireProjectMember(
  db: Database,
  request: FastifyRequest,
  projectId: string,
): Promise<ProjectMembership> {
  const user = requireAuth(request);
  const project = await loadProject(db, projectId);

  const rows = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, user.id),
      ),
    )
    .limit(1);
  const membership = rows[0];
  // A global admin is lead-equivalent on EVERY project (§6.3) — including ones they
  // happen to be enrolled in with a lower membership role. Resolve their role to
  // 'lead' regardless, so lead-gated actions (review, assign, manage members) don't
  // 403 just because an admin is also a plain member of the project.
  const isGlobalAdmin = user.role === 'admin';

  if (membership) {
    return {
      user,
      project,
      projectRole: isGlobalAdmin ? 'lead' : membership.role,
      isMemberRow: true,
    };
  }

  if (isGlobalAdmin) {
    return { user, project, projectRole: 'lead', isMemberRow: false };
  }

  // Non-members must not learn whether the project exists.
  throw forbidden('你不是该项目成员');
}

/**
 * Require the user to be a project lead (or global admin). Builds on
 * requireProjectMember.
 */
export async function requireProjectLead(
  db: Database,
  request: FastifyRequest,
  projectId: string,
): Promise<ProjectMembership> {
  const ctx = await requireProjectMember(db, request, projectId);
  if (ctx.projectRole !== 'lead') {
    throw forbidden('需要项目负责人权限');
  }
  return ctx;
}

/**
 * Resolved access context for a task (§6.3 / §8), produced by
 * {@link requireTaskVisibility}. For a project task `membership` is the caller's
 * project membership; for a no-project (pool) task it is null (any authenticated user
 * may see it). `isLead` is the lead-equivalent manager flag: a project lead/admin for
 * a project task, or the creator/admin for a no-project task.
 */
export interface TaskAccessContext {
  user: UserRow;
  membership: ProjectMembership | null;
  isLead: boolean;
}

/**
 * Resolve who the caller is relative to `task`, enforcing visibility (§6.3 / §8):
 * - project task: the caller must be a member (or global admin) → 403 otherwise.
 * - no-project (pool) task: visible to every authenticated active user.
 *
 * `isLead` carries the lead-equivalent manage flag so callers can gate reviews /
 * dispatch / member-removal uniformly across project and pool tasks.
 */
export async function requireTaskVisibility(
  db: Database,
  request: FastifyRequest,
  task: TaskRow,
): Promise<TaskAccessContext> {
  if (task.projectId === null) {
    const user = requireAuth(request);
    return { user, membership: null, isLead: canEditNoProjectTask(user, task) };
  }
  const membership = await requireProjectMember(db, request, task.projectId);
  const isLead =
    membership.projectRole === 'lead' || membership.user.role === 'admin';
  return { user: membership.user, membership, isLead };
}

/**
 * Whether `user` may edit/delete a *project* `task` within `membership` (§6.3):
 * - global admin: yes
 * - project lead: yes (any task in the project)
 * - member: only tasks they created
 *
 * No-project (task-pool) tasks have no project/lead and are governed by
 * {@link canEditNoProjectTask} instead (§8); this helper assumes a project task.
 */
export function canEditTask(membership: ProjectMembership, task: TaskRow): boolean {
  const { user, projectRole } = membership;
  if (user.role === 'admin') return true;
  if (projectRole === 'lead') return true;
  return task.createdBy === user.id;
}

/**
 * Whether `user` may edit/delete/assign a no-project (task-pool) task (§8). With no
 * project lead, the gate is: the task creator OR a global admin.
 */
export function canEditNoProjectTask(user: UserRow, task: TaskRow): boolean {
  return user.role === 'admin' || task.createdBy === user.id;
}

/**
 * Whether `user` may review (approve/reject/revoke) a no-project (pool) task (§8).
 * A pool task has no project lead, so its CREATOR is not a reviewer — only a global
 * admin may review it. (A non-lead must not be able to approve a task merely because
 * they created it; that would let non-leads complete tasks and self-credit points.)
 */
export function canReviewNoProjectTask(user: UserRow): boolean {
  return user.role === 'admin';
}

