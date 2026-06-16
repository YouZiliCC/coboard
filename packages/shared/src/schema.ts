import { z } from 'zod';
import {
  activityTypeSchema,
  prioritySchema,
  projectRoleSchema,
  taskStatusSchema,
  userRoleSchema,
} from './enums.js';

/**
 * Zod contracts — the single source of truth for every request/response body
 * (§7) and every entity (§5). Front-end forms and back-end validation both import
 * from here. Keep this exhaustive; downstream agents depend on it.
 *
 * Conventions:
 * - Timestamps cross the wire as ISO-8601 strings (JSON-serialized Date).
 * - UUIDs validated with `.uuid()`.
 * - `*Input` schemas describe request bodies; `*Schema` (no suffix) describe
 *   persisted entities as returned by the API.
 */

// ---------------------------------------------------------------------------
// Primitive / shared helpers
// ---------------------------------------------------------------------------

export const uuidSchema = z.string().uuid();
/** ISO-8601 datetime string (e.g. "2026-06-15T08:00:00.000Z"). */
export const isoDateTimeSchema = z.string().datetime({ offset: true });
/** Calendar date string "YYYY-MM-DD" (tasks.due_date). */
export const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

export const emailSchema = z.string().trim().email('邮箱格式不正确').max(254);
export const passwordSchema = z.string().min(8, '密码至少 8 位').max(200);
export const displayNameSchema = z.string().trim().min(1, '昵称不能为空').max(80);
/** Hex color for avatar background, e.g. "#3b82f6". */
export const avatarColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '颜色应为 #RRGGBB 格式');
/** Project short key — used in URLs/labels, uppercase-ish slug. */
export const projectKeySchema = z
  .string()
  .trim()
  .min(2, '项目标识至少 2 位')
  .max(10, '项目标识最多 10 位')
  .regex(/^[A-Z0-9]+$/, '项目标识只能包含大写字母和数字');

// ---------------------------------------------------------------------------
// Entities (§5) — shapes as returned by the API
// ---------------------------------------------------------------------------

/** Public-safe user (never includes password_hash). */
export const userSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  displayName: displayNameSchema,
  avatarColor: avatarColorSchema,
  role: userRoleSchema,
  isActive: z.boolean(),
  /** Whether the user has uploaded a profile picture (fetch via /users/:id/avatar). */
  hasAvatar: z.boolean(),
  createdAt: isoDateTimeSchema,
});
export type User = z.infer<typeof userSchema>;

export const sessionSchema = z.object({
  id: z.string(),
  userId: uuidSchema,
  createdAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});
export type Session = z.infer<typeof sessionSchema>;

export const projectSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  key: projectKeySchema,
  description: z.string().nullable(),
  archived: z.boolean(),
  createdBy: uuidSchema,
  createdAt: isoDateTimeSchema,
});
export type Project = z.infer<typeof projectSchema>;

export const projectMemberSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  userId: uuidSchema,
  role: projectRoleSchema,
  createdAt: isoDateTimeSchema,
});
export type ProjectMember = z.infer<typeof projectMemberSchema>;

/** Project member joined with its user (returned by GET /projects/:id/members). */
export const projectMemberWithUserSchema = projectMemberSchema.extend({
  user: userSchema,
});
export type ProjectMemberWithUser = z.infer<typeof projectMemberWithUserSchema>;

/**
 * A claimant of a task as embedded in the task wire shape (lifecycle v2 §2/§3):
 * the user's display summary plus their points share. `points` is null until the
 * task is delivered (and is reset to null again on a reject). This is a display
 * summary; the full user row is not carried.
 */
export const taskClaimantSchema = z.object({
  userId: uuidSchema,
  displayName: displayNameSchema,
  avatarColor: avatarColorSchema,
  /** Whether the claimant has an uploaded avatar (fetch via /users/:id/avatar). */
  hasAvatar: z.boolean(),
  /** Per-claimant points share; null until delivered / after a reject. */
  points: z.number().int().nullable(),
  claimedAt: isoDateTimeSchema,
});
export type TaskClaimant = z.infer<typeof taskClaimantSchema>;

/**
 * Task wire shape (lifecycle v2 §2/§3). The single `assigneeId`/`completedBy`
 * fields are gone — the set of workers is carried in `claimants`. `deliveredAt`/
 * `deliveredBy` are set on deliver and cleared on reject; `reviewedBy` is the last
 * reviewer; `completedAt` is set when a review approves the task.
 */
export const taskSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  title: z.string(),
  description: z.string().nullable(),
  status: taskStatusSchema,
  points: z.number().int().nonnegative().nullable(),
  priority: prioritySchema,
  dueDate: dateOnlySchema.nullable(),
  createdBy: uuidSchema,
  rank: z.string(),
  completedAt: isoDateTimeSchema.nullable(),
  deliveredAt: isoDateTimeSchema.nullable(),
  deliveredBy: uuidSchema.nullable(),
  reviewedBy: uuidSchema.nullable(),
  /** The set of users who have claimed this task, with their points shares. */
  claimants: z.array(taskClaimantSchema),
  createdAt: isoDateTimeSchema,
});
export type Task = z.infer<typeof taskSchema>;

export const commentSchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  authorId: uuidSchema,
  body: z.string(),
  mentions: z.array(uuidSchema),
  createdAt: isoDateTimeSchema,
  editedAt: isoDateTimeSchema.nullable(),
});
export type Comment = z.infer<typeof commentSchema>;

/** Comment joined with its author (returned by GET /tasks/:id/comments). */
export const commentWithAuthorSchema = commentSchema.extend({
  author: userSchema,
});
export type CommentWithAuthor = z.infer<typeof commentWithAuthorSchema>;

/** Activity meta is free-form jsonb (e.g. {from, to} for status_changed). */
export const activityMetaSchema = z.record(z.string(), z.unknown());
export type ActivityMeta = z.infer<typeof activityMetaSchema>;

export const activitySchema = z.object({
  id: uuidSchema,
  taskId: uuidSchema,
  projectId: uuidSchema,
  actorId: uuidSchema,
  type: activityTypeSchema,
  meta: activityMetaSchema,
  createdAt: isoDateTimeSchema,
});
export type Activity = z.infer<typeof activitySchema>;

/** Activity joined with its actor (returned by GET /tasks/:id/activities). */
export const activityWithActorSchema = activitySchema.extend({
  actor: userSchema,
});
export type ActivityWithActor = z.infer<typeof activityWithActorSchema>;

// ---------------------------------------------------------------------------
// Error shape (§7)
// ---------------------------------------------------------------------------

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level validation errors: path -> messages. */
    fields: z.record(z.string(), z.array(z.string())).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Setup & auth (§7)
// ---------------------------------------------------------------------------

/** GET /setup/status */
export const setupStatusResponseSchema = z.object({
  needsSetup: z.boolean(),
});
export type SetupStatusResponse = z.infer<typeof setupStatusResponseSchema>;

/** POST /setup — create first admin when no users exist. */
export const setupInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
});
export type SetupInput = z.infer<typeof setupInputSchema>;

/** POST /auth/login */
export const loginInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, '请输入密码').max(200),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/** Response for login / me — the authenticated user. */
export const authUserResponseSchema = z.object({
  user: userSchema,
});
export type AuthUserResponse = z.infer<typeof authUserResponseSchema>;

/** POST /auth/password — change own password. */
export const changePasswordInputSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(200),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordInputSchema>;

/** PATCH /auth/profile — update the current user's own profile (display name). */
export const updateProfileInputSchema = z.object({
  displayName: displayNameSchema,
});
export type UpdateProfileInput = z.infer<typeof updateProfileInputSchema>;

/**
 * POST /auth/avatar — upload a profile picture. `image` is a data URL such as
 * `data:image/jpeg;base64,<...>`. The server re-validates the mime + decoded
 * byte size; the 2 MB string cap here is a coarse upper bound on the request.
 */
export const updateAvatarInputSchema = z.object({
  image: z.string().min(1).max(2_000_000),
});
export type UpdateAvatarInput = z.infer<typeof updateAvatarInputSchema>;

// ---------------------------------------------------------------------------
// Self-registration (admin-gated by an invite code) (§8, §11 moved into v1)
// ---------------------------------------------------------------------------

/**
 * POST /auth/register — self-register a `member` account, gated by the admin's
 * invite code. Reuses the shared email/password/displayName rules; `code` is the
 * verification code the admin shares out-of-band.
 */
export const registerInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  code: z.string().min(1, '请输入验证码').max(200),
});
export type RegisterInput = z.infer<typeof registerInputSchema>;

/**
 * GET /auth/registration — public probe of whether self-registration is open.
 * Never exposes the code itself: `enabled` is true only when registration is
 * enabled AND a non-empty code is configured.
 */
export const registrationStatusSchema = z.object({
  enabled: z.boolean(),
});
export type RegistrationStatus = z.infer<typeof registrationStatusSchema>;

/** GET /settings — admin-only registration settings (includes the secret code). */
export const registrationSettingsSchema = z.object({
  registrationEnabled: z.boolean(),
  registrationCode: z.string().max(200),
});
export type RegistrationSettings = z.infer<typeof registrationSettingsSchema>;

/** PATCH /settings — admin updates either field (both optional). */
export const updateRegistrationSettingsInputSchema = z
  .object({
    registrationEnabled: z.boolean().optional(),
    registrationCode: z.string().max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一个字段',
  });
export type UpdateRegistrationSettingsInput = z.infer<
  typeof updateRegistrationSettingsInputSchema
>;

// ---------------------------------------------------------------------------
// Users (admin) (§7)
// ---------------------------------------------------------------------------

/**
 * A user's membership in a single project, as embedded in the admin user list.
 * Lets the admin console show each account's projects (and flag orphaned users
 * who belong to none, so they can't see any board, §6.3).
 */
export const userProjectMembershipSchema = z.object({
  projectId: uuidSchema,
  projectName: z.string(),
  role: projectRoleSchema,
});
export type UserProjectMembership = z.infer<typeof userProjectMembershipSchema>;

/** User with their project memberships — the admin §7 GET /users row shape. */
export const userWithProjectsSchema = userSchema.extend({
  projects: z.array(userProjectMembershipSchema),
});
export type UserWithProjects = z.infer<typeof userWithProjectsSchema>;

export const usersListResponseSchema = z.object({
  users: z.array(userWithProjectsSchema),
});
export type UsersListResponse = z.infer<typeof usersListResponseSchema>;

/** POST /users — admin creates an account with an initial password. */
export const createUserInputSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: displayNameSchema,
  role: userRoleSchema.default('member'),
  avatarColor: avatarColorSchema.optional(),
});
export type CreateUserInput = z.infer<typeof createUserInputSchema>;

/** PATCH /users/:id — admin edits name/role/active state. */
export const updateUserInputSchema = z
  .object({
    displayName: displayNameSchema.optional(),
    role: userRoleSchema.optional(),
    isActive: z.boolean().optional(),
    avatarColor: avatarColorSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一个字段',
  });
export type UpdateUserInput = z.infer<typeof updateUserInputSchema>;

// ---------------------------------------------------------------------------
// Projects (§7)
// ---------------------------------------------------------------------------

export const projectsListResponseSchema = z.object({
  projects: z.array(projectSchema),
});
export type ProjectsListResponse = z.infer<typeof projectsListResponseSchema>;

/**
 * A project as shown in the self-service directory (GET /projects/directory):
 * the project plus whether the current user is already a member and how many
 * members it has. Any logged-in user can browse the directory and join/leave.
 */
export const projectDirectoryItemSchema = projectSchema.extend({
  isMember: z.boolean(),
  memberCount: z.number().int().nonnegative(),
});
export type ProjectDirectoryItem = z.infer<typeof projectDirectoryItemSchema>;

export const projectDirectoryResponseSchema = z.object({
  projects: z.array(projectDirectoryItemSchema),
});
export type ProjectDirectoryResponse = z.infer<
  typeof projectDirectoryResponseSchema
>;

/** POST /projects (admin). */
export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1, '项目名称不能为空').max(120),
  key: projectKeySchema,
  description: z.string().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

/** PATCH /projects/:id. */
export const updateProjectInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(2000).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一个字段',
  });
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const projectMembersResponseSchema = z.object({
  members: z.array(projectMemberWithUserSchema),
});
export type ProjectMembersResponse = z.infer<typeof projectMembersResponseSchema>;

/** POST /projects/:id/members. */
export const addProjectMemberInputSchema = z.object({
  userId: uuidSchema,
  role: projectRoleSchema.default('member'),
});
export type AddProjectMemberInput = z.infer<typeof addProjectMemberInputSchema>;

// ---------------------------------------------------------------------------
// Tasks (§7)
// ---------------------------------------------------------------------------

/** Board payload: tasks grouped by column. */
export const boardResponseSchema = z.object({
  tasks: z.array(taskSchema),
});
export type BoardResponse = z.infer<typeof boardResponseSchema>;

export const taskResponseSchema = z.object({
  task: taskSchema,
});
export type TaskResponse = z.infer<typeof taskResponseSchema>;

/** POST /projects/:id/tasks. */
export const createTaskInputSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(200),
  description: z.string().max(20000).optional(),
  priority: prioritySchema.default('medium'),
  points: z.number().int().nonnegative().max(1000).nullable().optional(),
  dueDate: dateOnlySchema.nullable().optional(),
  /** Optionally dispatch on creation; moves task to in_progress. */
  assigneeId: uuidSchema.nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

/** PATCH /tasks/:id — edit fields / status / rank. */
export const updateTaskInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20000).nullable().optional(),
    status: taskStatusSchema.optional(),
    priority: prioritySchema.optional(),
    points: z.number().int().nonnegative().max(1000).nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    /** Lexicographic rank key for intra-column ordering. */
    rank: z.string().min(1).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '至少修改一个字段',
  });
export type UpdateTaskInput = z.infer<typeof updateTaskInputSchema>;

/** POST /tasks/:id/assign — lead/admin dispatch (adds the user to claimants). */
export const assignTaskInputSchema = z.object({
  assigneeId: uuidSchema,
});
export type AssignTaskInput = z.infer<typeof assignTaskInputSchema>;

// /tasks/:id/claim takes no body.

/**
 * POST /tasks/:id/release — optional body (lifecycle v2 §3). Self-release omits the
 * body; a lead/admin may remove another claimant by passing their `userId`.
 */
export const releaseTaskInputSchema = z.object({
  userId: uuidSchema.optional(),
});
export type ReleaseTaskInput = z.infer<typeof releaseTaskInputSchema>;

/**
 * One claimant's points share within a deliver request (lifecycle v2 §3). Points
 * are non-negative integers; the allocations must cover exactly the current set of
 * claimants and their sum must equal the task points (or `totalPoints`).
 */
export const deliverAllocationSchema = z.object({
  userId: uuidSchema,
  points: z.number().int().nonnegative().max(100000),
});
export type DeliverAllocation = z.infer<typeof deliverAllocationSchema>;

/**
 * POST /tasks/:id/deliver — a claimant (or lead/admin) submits the points split
 * for review (lifecycle v2 §3). `allocations` must cover every current claimant.
 * When the task has no points yet, `totalPoints` supplies the total to split and is
 * written back onto the task. The server re-validates that the sum matches.
 */
export const deliverTaskInputSchema = z.object({
  allocations: z.array(deliverAllocationSchema).min(1, '至少需要一个认领者的分配'),
  /** Required only when the task has no points; the total to split + persist. */
  totalPoints: z.number().int().nonnegative().max(100000).optional(),
});
export type DeliverTaskInput = z.infer<typeof deliverTaskInputSchema>;

/** Review decision (lifecycle v2 §3). */
export const reviewDecisionSchema = z.enum(['approve', 'reject']);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * POST /tasks/:id/review — lead/admin approves or rejects a `pending_review` task
 * (lifecycle v2 §3). `approve` → done (shares locked); `reject` → in_progress with
 * shares cleared. `comment` is an optional rejection reason recorded on the activity.
 */
export const reviewTaskInputSchema = z.object({
  decision: reviewDecisionSchema,
  comment: z.string().trim().max(2000).optional(),
});
export type ReviewTaskInput = z.infer<typeof reviewTaskInputSchema>;

// ---------------------------------------------------------------------------
// Comments & activities (§7)
// ---------------------------------------------------------------------------

export const commentsResponseSchema = z.object({
  comments: z.array(commentWithAuthorSchema),
});
export type CommentsResponse = z.infer<typeof commentsResponseSchema>;

/** POST /tasks/:id/comments. */
export const createCommentInputSchema = z.object({
  body: z.string().trim().min(1, '评论不能为空').max(20000),
  mentions: z.array(uuidSchema).max(50).optional(),
});
export type CreateCommentInput = z.infer<typeof createCommentInputSchema>;

/** PATCH /comments/:id. */
export const updateCommentInputSchema = z.object({
  body: z.string().trim().min(1, '评论不能为空').max(20000),
  mentions: z.array(uuidSchema).max(50).optional(),
});
export type UpdateCommentInput = z.infer<typeof updateCommentInputSchema>;

export const activitiesResponseSchema = z.object({
  activities: z.array(activityWithActorSchema),
});
export type ActivitiesResponse = z.infer<typeof activitiesResponseSchema>;

// ---------------------------------------------------------------------------
// Stats (§7 / §6.4)
// ---------------------------------------------------------------------------

export const statsSortSchema = z.enum(['count', 'points']);
export type StatsSort = z.infer<typeof statsSortSchema>;

/** Query for GET /stats/leaderboard. */
export const leaderboardQuerySchema = z.object({
  projectId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  sort: statsSortSchema.default('count'),
});
export type LeaderboardQuery = z.infer<typeof leaderboardQuerySchema>;

export const leaderboardEntrySchema = z.object({
  user: userSchema,
  completedCount: z.number().int().nonnegative(),
  pointsSum: z.number().int().nonnegative(),
});
export type LeaderboardEntry = z.infer<typeof leaderboardEntrySchema>;

export const leaderboardResponseSchema = z.object({
  entries: z.array(leaderboardEntrySchema),
});
export type LeaderboardResponse = z.infer<typeof leaderboardResponseSchema>;

/** Query for GET /stats/me. */
export const myStatsQuerySchema = z.object({
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
});
export type MyStatsQuery = z.infer<typeof myStatsQuerySchema>;

export const myStatsResponseSchema = z.object({
  completedCount: z.number().int().nonnegative(),
  pointsSum: z.number().int().nonnegative(),
});
export type MyStatsResponse = z.infer<typeof myStatsResponseSchema>;

/** Query for GET /stats/trend. */
export const trendBucketSchema = z.enum(['day', 'week']);
export type TrendBucket = z.infer<typeof trendBucketSchema>;

export const trendQuerySchema = z.object({
  userId: uuidSchema.optional(),
  from: isoDateTimeSchema.optional(),
  to: isoDateTimeSchema.optional(),
  bucket: trendBucketSchema.default('day'),
});
export type TrendQuery = z.infer<typeof trendQuerySchema>;

export const trendPointSchema = z.object({
  /** Bucket start as a date string "YYYY-MM-DD". */
  date: dateOnlySchema,
  completedCount: z.number().int().nonnegative(),
  pointsSum: z.number().int().nonnegative(),
});
export type TrendPoint = z.infer<typeof trendPointSchema>;

export const trendResponseSchema = z.object({
  points: z.array(trendPointSchema),
});
export type TrendResponse = z.infer<typeof trendResponseSchema>;

// ---------------------------------------------------------------------------
// Realtime / SSE (§6.5)
// ---------------------------------------------------------------------------

/** Logical entity a realtime event concerns — drives query invalidation. */
export const realtimeEntitySchema = z.enum(['task', 'comment', 'activity', 'project']);
export type RealtimeEntity = z.infer<typeof realtimeEntitySchema>;

/**
 * SSE payload broadcast on any successful write (§6.5). `type` carries the
 * activity/event semantic; `entity` tells the client which queries to invalidate.
 */
export const realtimeEventSchema = z.object({
  type: z.string(),
  projectId: uuidSchema,
  entity: realtimeEntitySchema,
  payload: z.record(z.string(), z.unknown()),
});
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

// ---------------------------------------------------------------------------
// Common path-param schemas (reused by route validation)
// ---------------------------------------------------------------------------

export const idParamSchema = z.object({ id: uuidSchema });
export type IdParam = z.infer<typeof idParamSchema>;

export const projectMemberParamsSchema = z.object({
  id: uuidSchema,
  userId: uuidSchema,
});
export type ProjectMemberParams = z.infer<typeof projectMemberParamsSchema>;
