import type { ProjectMemberWithUser, ProjectRole, Task, User } from 'shared';

/**
 * Front-end permission predicates (§6.3). These mirror the server guards so the
 * UI can hide actions a user can't perform — but they are NOT a security boundary
 * (the server re-checks every write). Keep them conservative and aligned with the
 * spec; when in doubt, show the control and let the server reject.
 */

export interface TaskPermissionContext {
  user: User | null;
  /** The current user's per-project role, if a member of this project. */
  projectRole: ProjectRole | undefined;
}

/** Resolve the current user's project role from the members list. */
export function resolveProjectRole(
  members: ProjectMemberWithUser[] | undefined,
  userId: string | undefined,
): ProjectRole | undefined {
  if (!members || !userId) return undefined;
  return members.find((m) => m.userId === userId)?.role;
}

/** Is the given task a no-project / task-pool task (§8)? */
export function isPoolTask(task: Task): boolean {
  return task.projectId === null;
}

/**
 * The "manager" tier for a given task — i.e. who may review / assign / edit-any /
 * delete-any.
 * - project task (§6.3): global admin OR the project's lead.
 * - no-project (pool) task (§8): global admin OR the task's creator (there is no
 *   project lead).
 */
export function isManager(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (ctx.user.role === 'admin') return true;
  if (isPoolTask(task)) return task.createdBy === ctx.user.id;
  return ctx.projectRole === 'lead';
}

/** Is the current user among the task's claimants (lifecycle v2 §2)? */
export function isClaimant(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  return task.claimants.some((c) => c.userId === ctx.user!.id);
}

/**
 * Can the user edit a task's fields / move it on the board (§6.3, v2; §8)?
 * - manager (admin/lead, or pool-task creator): any such task.
 * - member: tasks they created or have claimed.
 */
export function canEditTask(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (isManager(ctx, task)) return true;
  return task.createdBy === ctx.user.id || isClaimant(ctx, task);
}

/** Can the user delete a task? manager, or the creator (§6.3, §8). */
export function canDeleteTask(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (isManager(ctx, task)) return true;
  return task.createdBy === ctx.user.id;
}

/** Can the user dispatch (assign) on this task? manager only (§6.2, §8). */
export function canAssign(ctx: TaskPermissionContext, task: Task): boolean {
  return isManager(ctx, task);
}

/** Is the task at its claim capacity (claim-limits)? null max ⇒ never full. */
export function isClaimFull(task: Task): boolean {
  return task.maxClaimants != null && task.claimants.length >= task.maxClaimants;
}

/** Is the task still below its lower claim bound (claim-limits, 未达下限)? */
export function isBelowMinClaimants(task: Task): boolean {
  return task.claimants.length < task.minClaimants;
}

/**
 * Can the user claim this task? any member, when it's open / in_progress, they are
 * not already a claimant, and the upper claim bound has not been reached
 * (lifecycle v2 §3; claim-limits).
 */
export function canClaim(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (task.status !== 'open' && task.status !== 'in_progress') return false;
  if (isClaimFull(task)) return false;
  return !isClaimant(ctx, task);
}

/**
 * Can the user deliver this task (open the points-split dialog)? a claimant or a
 * manager, while the task is in_progress (lifecycle v2 §3).
 */
export function canDeliver(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user || task.status !== 'in_progress') return false;
  if (task.claimants.length === 0) return false;
  return isClaimant(ctx, task) || isManager(ctx, task);
}

/**
 * The reviewer tier — who may approve / reject / 撤销通过 a task (v2 §3, §8). Unlike
 * {@link isManager}, the CREATOR of a pool task is NOT a reviewer: a pool task has no
 * project lead, so only a global admin may review it (a non-lead must not approve a
 * task merely because they created it). Project task: global admin or the project lead.
 */
function isReviewer(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (ctx.user.role === 'admin') return true;
  if (isPoolTask(task)) return false;
  return ctx.projectRole === 'lead';
}

/**
 * Can the user review this task? while pending_review, the reviewer tier (v2 §3, §8)
 * — admin/lead for a project task, admin only for a pool task.
 */
export function canReview(ctx: TaskPermissionContext, task: Task): boolean {
  return task.status === 'pending_review' && isReviewer(ctx, task);
}

/**
 * Can the user 撤销通过 (revoke approval) of this task? the reviewer tier, while the
 * task is `done` — sends it back to 待审阅 for re-review.
 */
export function canRevokeApproval(ctx: TaskPermissionContext, task: Task): boolean {
  return task.status === 'done' && isReviewer(ctx, task);
}
