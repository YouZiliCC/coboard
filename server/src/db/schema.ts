import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  activityTypes,
  priorities,
  projectRoles,
  taskStatuses,
  userRoles,
} from 'shared';

/**
 * Drizzle pg-core schema (§5). Every table has a uuid `id` defaulting to
 * `gen_random_uuid()` and a `created_at`; tables that mutate also carry
 * `updated_at`. Enum value lists are imported from the shared contract so the DB
 * and the wire types never drift.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRoleEnum = pgEnum('user_role', userRoles);
export const projectRoleEnum = pgEnum('project_role', projectRoles);
export const taskStatusEnum = pgEnum('task_status', taskStatuses);
export const priorityEnum = pgEnum('priority', priorities);
export const activityTypeEnum = pgEnum('activity_type', activityTypes);

const primaryId = uuid('id')
  .primaryKey()
  .default(sql`gen_random_uuid()`);

const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .defaultNow();

// ---------------------------------------------------------------------------
// users (§5)
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: primaryId,
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    avatarColor: text('avatar_color').notNull(),
    // Mime of the uploaded avatar (e.g. 'image/jpeg') when one exists; null
    // otherwise. Kept on the user row (vs the bytes) so list selects can derive
    // `hasAvatar` cheaply without ever fetching the image data.
    avatarMime: text('avatar_mime'),
    role: userRoleEnum('role').notNull().default('member'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt,
  },
  (table) => [uniqueIndex('users_email_uniq').on(table.email)],
);

// ---------------------------------------------------------------------------
// user_avatars — uploaded profile-picture bytes, split off the users row so
// user-list queries never pull big base64 blobs (Change 1).
// ---------------------------------------------------------------------------

export const userAvatars = pgTable('user_avatars', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Base64-encoded image bytes (no `data:` prefix).
  data: text('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// sessions (§5)
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    // session token (random string) doubles as primary key.
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt,
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('sessions_user_id_idx').on(table.userId)],
);

// ---------------------------------------------------------------------------
// projects (§5)
// ---------------------------------------------------------------------------

export const projects = pgTable(
  'projects',
  {
    id: primaryId,
    name: text('name').notNull(),
    key: text('key').notNull(),
    description: text('description'),
    archived: boolean('archived').notNull().default(false),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt,
  },
  (table) => [uniqueIndex('projects_key_uniq').on(table.key)],
);

// ---------------------------------------------------------------------------
// project_members (§5)
// ---------------------------------------------------------------------------

export const projectMembers = pgTable(
  'project_members',
  {
    id: primaryId,
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: projectRoleEnum('role').notNull().default('member'),
    createdAt,
  },
  (table) => [
    uniqueIndex('project_members_project_user_uniq').on(
      table.projectId,
      table.userId,
    ),
    index('project_members_user_id_idx').on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// tasks (§5)
// ---------------------------------------------------------------------------

export const tasks = pgTable(
  'tasks',
  {
    id: primaryId,
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: taskStatusEnum('status').notNull().default('open'),
    // DEPRECATED (lifecycle v2 §2.2): single-assignee model replaced by the
    // `task_claimants` set. Column kept (not dropped) to de-risk the migration;
    // no code reads/writes it going forward.
    assigneeId: uuid('assignee_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    points: integer('points'),
    priority: priorityEnum('priority').notNull().default('medium'),
    dueDate: date('due_date'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // lexicographic ordering key used for intra-column drag ordering.
    rank: text('rank').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // DEPRECATED (lifecycle v2 §2.2): contribution attribution now lives on
    // `task_claimants`. Kept for migration safety; unused by the code.
    completedBy: uuid('completed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Lifecycle v2 (§2/§3): set on deliver, cleared on reject.
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    // Set by the reviewer on approve/reject (§3).
    reviewedBy: uuid('reviewed_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt,
  },
  (table) => [
    index('tasks_project_status_idx').on(table.projectId, table.status),
    index('tasks_assignee_idx').on(table.assigneeId),
    index('tasks_completed_at_idx').on(table.completedAt),
  ],
);

// ---------------------------------------------------------------------------
// task_claimants (lifecycle v2 §2) — the set of users who have claimed a task.
// Replaces the single-assignee model. `points` is the per-claimant share written
// at deliver time (NULL until then / after a reject). PK is (task_id, user_id).
// ---------------------------------------------------------------------------

export const taskClaimants = pgTable(
  'task_claimants',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Per-claimant points share; null until delivered, cleared again on reject.
    points: integer('points'),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.userId] }),
    index('task_claimants_user_id_idx').on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// comments (§5)
// ---------------------------------------------------------------------------

export const comments = pgTable(
  'comments',
  {
    id: primaryId,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    // mentioned user ids; uuid[] column.
    mentions: uuid('mentions')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt,
    editedAt: timestamp('edited_at', { withTimezone: true }),
  },
  (table) => [index('comments_task_id_idx').on(table.taskId)],
);

// ---------------------------------------------------------------------------
// activities (§5)
// ---------------------------------------------------------------------------

export const activities = pgTable(
  'activities',
  {
    id: primaryId,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: activityTypeEnum('type').notNull(),
    meta: jsonb('meta')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt,
  },
  (table) => [
    index('activities_task_created_idx').on(table.taskId, table.createdAt),
    index('activities_project_created_idx').on(table.projectId, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// settings — key/value store for admin-settable instance config (§8)
// ---------------------------------------------------------------------------

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// Inferred row types (server-internal; wire types live in `shared`)
// ---------------------------------------------------------------------------

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type UserAvatarRow = typeof userAvatars.$inferSelect;
export type NewUserAvatarRow = typeof userAvatars.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type ProjectMemberRow = typeof projectMembers.$inferSelect;
export type NewProjectMemberRow = typeof projectMembers.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskClaimantRow = typeof taskClaimants.$inferSelect;
export type NewTaskClaimantRow = typeof taskClaimants.$inferInsert;
export type CommentRow = typeof comments.$inferSelect;
export type NewCommentRow = typeof comments.$inferInsert;
export type ActivityRow = typeof activities.$inferSelect;
export type NewActivityRow = typeof activities.$inferInsert;
export type SettingRow = typeof settings.$inferSelect;
export type NewSettingRow = typeof settings.$inferInsert;

/** Convenience bundle so tests / db factory can pass the whole schema. */
export const schema = {
  users,
  userAvatars,
  sessions,
  projects,
  projectMembers,
  tasks,
  taskClaimants,
  comments,
  activities,
  settings,
  userRoleEnum,
  projectRoleEnum,
  taskStatusEnum,
  priorityEnum,
  activityTypeEnum,
};
