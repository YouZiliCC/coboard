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

/** Global admin or project lead — the "manager" tier (§6.3). */
export function isManager(ctx: TaskPermissionContext): boolean {
  return ctx.user?.role === 'admin' || ctx.projectRole === 'lead';
}

/** Is the current user among the task's claimants (lifecycle v2 §2)? */
export function isClaimant(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  return task.claimants.some((c) => c.userId === ctx.user!.id);
}

/**
 * Can the user edit a task's fields / move it on the board (§6.3, v2)?
 * - admin / lead: any task in the project.
 * - member: tasks they created or have claimed.
 */
export function canEditTask(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (isManager(ctx)) return true;
  return task.createdBy === ctx.user.id || isClaimant(ctx, task);
}

/** Can the user delete a task? admin / lead, or the creator (§6.3). */
export function canDeleteTask(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (isManager(ctx)) return true;
  return task.createdBy === ctx.user.id;
}

/** Can the user dispatch (assign) tasks? admin / lead only (§6.2). */
export function canAssign(ctx: TaskPermissionContext): boolean {
  return isManager(ctx);
}

/**
 * Can the user release (themselves from) this task? a claimant, or a manager when
 * there is at least one claimant to remove (lifecycle v2 §3).
 */
export function canRelease(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (isClaimant(ctx, task)) return true;
  return isManager(ctx) && task.claimants.length > 0;
}

/**
 * Can the user claim this task? any member, when it's open / in_progress and they
 * are not already a claimant (lifecycle v2 §3).
 */
export function canClaim(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user) return false;
  if (task.status !== 'open' && task.status !== 'in_progress') return false;
  return !isClaimant(ctx, task);
}

/**
 * Can the user deliver this task (open the points-split dialog)? a claimant or a
 * manager, while the task is in_progress (lifecycle v2 §3).
 */
export function canDeliver(ctx: TaskPermissionContext, task: Task): boolean {
  if (!ctx.user || task.status !== 'in_progress') return false;
  if (task.claimants.length === 0) return false;
  return isClaimant(ctx, task) || isManager(ctx);
}

/** Can the user review this task? manager only, while pending_review (v2 §3). */
export function canReview(ctx: TaskPermissionContext, task: Task): boolean {
  return task.status === 'pending_review' && isManager(ctx);
}
