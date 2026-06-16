import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
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
  ideaStatuses,
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
export const ideaStatusEnum = pgEnum('idea_status', ideaStatuses);

const primaryId = uuid('id')
  .primaryKey()
  .default(sql`gen_random_uuid()`);

const createdAt = timestamp('created_at', { withTimezone: true })
  .notNull()
  .defaultNow();

/**
 * Postgres `bytea` column carrying raw binary data as a Node `Buffer` (§7.2). Used
 * for task-file attachment bytes stored directly in the database (so files are
 * captured in DB backups). Drizzle has no built-in bytea type, so we define one;
 * the driver round-trips a Buffer to/from the bytea on the wire.
 */
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea';
  },
});

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
    // Nullable (§8): a NULL project_id is a "no-project" / task-pool task, shared
    // with every logged-in user. Project tasks reference their owning project and
    // are visible only to its members.
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
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
    // Nullable (§8): mirrors tasks.project_id — a no-project task's activities
    // carry a NULL project_id and fan out on the global (null-project) channel.
    projectId: uuid('project_id').references(() => projects.id, {
      onDelete: 'cascade',
    }),
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
// ideas (§7.1) — inspiration / suggestions. Either posted against a task (the
// task's 想法 section) or STANDALONE in the 灵感区 (task_id NULL — no owning
// project, visible to every logged-in user). A lead/admin may adopt one (writing
// reward_points credited to the author's contribution) or reject it. Task ideas
// cascade with their owning task.
// ---------------------------------------------------------------------------

export const ideas = pgTable(
  'ideas',
  {
    id: primaryId,
    // Nullable: a NULL task_id is a STANDALONE 灵感区 idea (no task / project),
    // visible to all logged-in users. Task ideas reference their owning task and
    // cascade with it.
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    body: text('body').notNull(),
    status: ideaStatusEnum('status').notNull().default('pending'),
    // Reward points written on adoption; null until then / after a reject.
    rewardPoints: integer('reward_points'),
    // The lead/admin who adopted the idea; null otherwise.
    adoptedBy: uuid('adopted_by').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt,
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('ideas_task_id_idx').on(table.taskId),
    index('ideas_author_id_idx').on(table.authorId),
  ],
);

// ---------------------------------------------------------------------------
// task_files (§7.2) — file attachments uploaded against a task (used to deliver
// file content). The raw bytes live in `data` (bytea) so files ride along with DB
// backups; single-file uploads are capped at 5MB server-side. Cascades with the
// owning task.
// ---------------------------------------------------------------------------

export const taskFiles = pgTable(
  'task_files',
  {
    id: primaryId,
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    // Raw file bytes; never selected into list/metadata queries.
    data: bytea('data').notNull(),
    createdAt,
  },
  (table) => [index('task_files_task_id_idx').on(table.taskId)],
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
export type IdeaRow = typeof ideas.$inferSelect;
export type NewIdeaRow = typeof ideas.$inferInsert;
export type TaskFileRow = typeof taskFiles.$inferSelect;
export type NewTaskFileRow = typeof taskFiles.$inferInsert;
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
  ideas,
  taskFiles,
  settings,
  userRoleEnum,
  projectRoleEnum,
  taskStatusEnum,
  priorityEnum,
  activityTypeEnum,
  ideaStatusEnum,
};
