import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreateProjectInput,
  Project,
  ProjectDirectoryItem,
  ProjectMemberWithUser,
  ProjectRole,
  UpdateProjectInput,
  User,
} from 'shared';
import type { Database } from '../db/index.js';
import {
  projectMembers,
  projects,
  users,
  type ProjectMemberRow,
  type ProjectRow,
  type UserRow,
} from '../db/schema.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { publishChange } from './activityService.js';

/**
 * Project & membership business logic (§6.3, §7). Routes stay thin: they run the
 * auth/project guards and validate input, then delegate here. This module owns
 * visibility rules (non-members cannot see a project), lead/admin-only mutations,
 * uniqueness conflicts, and realtime fan-out for project/membership changes.
 *
 * Postgres uniqueness violation code; mapped to a 409 so concurrent/duplicate
 * writes surface as the §7 conflict shape rather than a 500.
 */
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

// ---------------------------------------------------------------------------
// Presenters: DB rows -> wire shapes (§5/§7). Dates become ISO-8601 strings.
// ---------------------------------------------------------------------------

/** Public-safe user (never leaks password_hash). */
export function presentUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    avatarColor: row.avatarColor,
    role: row.role,
    isActive: row.isActive,
    hasAvatar: row.avatarMime != null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function presentProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    key: row.key,
    description: row.description,
    archived: row.archived,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function presentMember(
  member: ProjectMemberRow,
  user: UserRow,
): ProjectMemberWithUser {
  return {
    id: member.id,
    projectId: member.projectId,
    userId: member.userId,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    user: presentUser(user),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Projects visible to a user (§6.3): admins see every project; everyone else sees
 * only the projects they are a member of. Ordered by creation time for stability.
 */
export async function listVisibleProjects(
  db: Database,
  user: UserRow,
): Promise<Project[]> {
  if (user.role === 'admin') {
    const rows = await db
      .select()
      .from(projects)
      .orderBy(asc(projects.createdAt));
    return rows.map(presentProject);
  }

  const rows = await db
    .select({ project: projects })
    .from(projectMembers)
    .innerJoin(projects, eq(projectMembers.projectId, projects.id))
    .where(eq(projectMembers.userId, user.id))
    .orderBy(asc(projects.createdAt));
  return rows.map((r) => presentProject(r.project));
}

/** Members of a project joined with their user, oldest first. */
export async function listProjectMembers(
  db: Database,
  projectId: string,
): Promise<ProjectMemberWithUser[]> {
  const rows = await db
    .select({ member: projectMembers, user: users })
    .from(projectMembers)
    .innerJoin(users, eq(projectMembers.userId, users.id))
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(asc(projectMembers.createdAt));
  return rows.map((r) => presentMember(r.member, r.user));
}

/**
 * Browsable directory of every non-archived project (self-service join/leave).
 * Unlike {@link listVisibleProjects}, any logged-in user sees all open projects;
 * each item carries whether the caller is already a member and the project's total
 * member count. Assembled from three flat queries (projects, the caller's
 * membership ids, grouped member counts) to avoid an N+1 over projects. Ordered by
 * name ascending for a stable, scannable list.
 */
export async function listProjectDirectory(
  db: Database,
  userId: string,
): Promise<ProjectDirectoryItem[]> {
  const projectRows = await db
    .select()
    .from(projects)
    .where(eq(projects.archived, false))
    .orderBy(asc(projects.name));

  if (projectRows.length === 0) {
    return [];
  }

  const projectIds = projectRows.map((p) => p.id);

  // The caller's memberships among these projects.
  const myMemberships = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        inArray(projectMembers.projectId, projectIds),
      ),
    );
  const memberOf = new Set(myMemberships.map((m) => m.projectId));

  // Total member count per project, grouped in a single query.
  const counts = await db
    .select({
      projectId: projectMembers.projectId,
      count: sql<number>`count(*)::int`,
    })
    .from(projectMembers)
    .where(inArray(projectMembers.projectId, projectIds))
    .groupBy(projectMembers.projectId);
  const countByProject = new Map(counts.map((c) => [c.projectId, c.count]));

  return projectRows.map((row) => ({
    ...presentProject(row),
    isMember: memberOf.has(row.id),
    memberCount: countByProject.get(row.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Create a project (admin only — enforced in the route) and auto-add the creator
 * as the project lead (§6.3 / §7). A duplicate `key` surfaces as a 409.
 */
export async function createProject(
  db: Database,
  creator: UserRow,
  input: CreateProjectInput,
): Promise<Project> {
  let row: ProjectRow | undefined;
  try {
    [row] = await db
      .insert(projects)
      .values({
        name: input.name,
        key: input.key,
        description: input.description ?? null,
        createdBy: creator.id,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('项目标识已被占用');
    }
    throw error;
  }

  if (!row) {
    throw new Error('创建项目失败：未返回插入行');
  }

  // Auto-enroll the creator as lead so they can manage the project immediately.
  await db.insert(projectMembers).values({
    projectId: row.id,
    userId: creator.id,
    role: 'lead',
  });

  const project = presentProject(row);
  publishChange({
    type: 'created',
    projectId: project.id,
    entity: 'project',
    payload: { projectId: project.id },
  });
  return project;
}

/**
 * Update a project's name/description/archived flag (§7). Caller must already be a
 * lead or admin (enforced via the project-lead guard in the route).
 */
export async function updateProject(
  db: Database,
  projectId: string,
  input: UpdateProjectInput,
): Promise<Project> {
  const patch: Partial<ProjectRow> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.archived !== undefined) patch.archived = input.archived;

  const [row] = await db
    .update(projects)
    .set(patch)
    .where(eq(projects.id, projectId))
    .returning();

  if (!row) {
    throw notFound('项目不存在');
  }

  const project = presentProject(row);
  publishChange({
    type: 'updated',
    projectId: project.id,
    entity: 'project',
    payload: { projectId: project.id },
  });
  return project;
}

/**
 * Add a user to a project with a role (§6.3 / §7). Validates the target user
 * exists and is not already a member; either condition yields the right §7 status
 * (404 for an unknown user, 409 for a duplicate membership).
 */
export async function addProjectMember(
  db: Database,
  projectId: string,
  // Accepts an optional `role` so the call site is independent of zod's
  // optional-vs-required default inference; defaults to 'member' (schema/DB default).
  input: { userId: string; role?: ProjectRole },
): Promise<ProjectMemberWithUser> {
  const role: ProjectRole = input.role ?? 'member';
  const [targetUser] = await db
    .select()
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);
  if (!targetUser) {
    throw notFound('用户不存在');
  }

  let member: ProjectMemberRow | undefined;
  try {
    [member] = await db
      .insert(projectMembers)
      .values({
        projectId,
        userId: input.userId,
        role,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('该用户已是项目成员');
    }
    throw error;
  }

  if (!member) {
    throw new Error('添加成员失败：未返回插入行');
  }

  publishChange({
    type: 'updated',
    projectId,
    entity: 'project',
    payload: { projectId, userId: input.userId },
  });
  return presentMember(member, targetUser);
}

/**
 * Last-lead invariant (§6.3): a project must never lose its only remaining lead,
 * or it becomes unmanageable. Call before removing a membership row; throws the
 * given AppError when `member` is the project's sole lead. Reused by both
 * lead/admin removal and self-service leave.
 */
async function assertNotLastLead(
  db: Database,
  projectId: string,
  member: ProjectMemberRow,
  error: ReturnType<typeof forbidden>,
): Promise<void> {
  if (member.role !== 'lead') return;
  const leads = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.role, 'lead'),
      ),
    );
  if (leads.length <= 1) {
    throw error;
  }
}

/**
 * Remove a user from a project (§6.3 / §7). Refuses to remove the project's last
 * lead so a project can never become unmanageable. A non-member yields a 404.
 */
export async function removeProjectMember(
  db: Database,
  projectId: string,
  userId: string,
): Promise<void> {
  const [member] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) {
    throw notFound('该用户不是项目成员');
  }

  await assertNotLastLead(db, projectId, member, forbidden('不能移除项目唯一的负责人'));

  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );

  publishChange({
    type: 'updated',
    projectId,
    entity: 'project',
    payload: { projectId, userId },
  });
}

/**
 * Self-service join (§6.3): any logged-in user adds themselves to a non-archived
 * project as a plain `member`. Idempotent — if a membership row already exists it
 * is left UNCHANGED (an existing `lead` is never downgraded). A missing or
 * archived project yields a 404.
 */
export async function joinProject(
  db: Database,
  userId: string,
  projectId: string,
): Promise<void> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.archived) {
    throw notFound('项目不存在');
  }

  const [existing] = await db
    .select({ id: projectMembers.id })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .limit(1);
  if (existing) {
    // Already a member — leave their role untouched and return idempotently.
    return;
  }

  try {
    await db
      .insert(projectMembers)
      .values({ projectId, userId, role: 'member' });
  } catch (error) {
    // A concurrent join can race past the existence check; treat the unique
    // violation as the same idempotent success.
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return;
  }

  publishChange({
    type: 'updated',
    projectId,
    entity: 'project',
    payload: { projectId, userId },
  });
}

/**
 * Self-service leave (§6.3): a user removes their own membership. A non-member
 * yields a 404; if they are the project's only remaining lead the leave is refused
 * with a 409 (they must hand off the lead role first).
 */
export async function leaveProject(
  db: Database,
  userId: string,
  projectId: string,
): Promise<void> {
  const [member] = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    )
    .limit(1);
  if (!member) {
    throw notFound('你不是该项目成员');
  }

  await assertNotLastLead(
    db,
    projectId,
    member,
    conflict('项目至少需要一名负责人，请先指派他人'),
  );

  await db
    .delete(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, userId),
      ),
    );

  publishChange({
    type: 'updated',
    projectId,
    entity: 'project',
    payload: { projectId, userId },
  });
}
