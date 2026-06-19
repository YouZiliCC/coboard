import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { LeaderboardResponse, Task } from 'shared';
import type { Database } from '../src/db/index.js';
import {
  projectMembers,
  projects,
  taskClaimants,
  tasks,
  users,
  type NewTaskRow,
} from '../src/db/schema.js';
import { createSession } from '../src/auth/session.js';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * No-project tasks / task pool + all-projects query feature tests (§8). Covers the
 * unified create endpoint, the shared task-pool visibility, the §8 permission matrix
 * (claim/deliver any user; review/revoke = global admin only — no project lead exists,
 * so the creator is not a reviewer; edit/delete = creator or admin),
 * the all-projects union with project context, and that a completed pool task counts
 * toward contribution stats.
 *
 * Auth mirrors tasks.test.ts: seed a session row + sign the cookie the auth
 * pre-handler reads.
 */

const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let ctx: TestContext;
let db: Database;
let seq = 0;

interface SeededUser {
  id: string;
  cookie: string;
}

async function seedUser(role: 'admin' | 'member' = 'member'): Promise<SeededUser> {
  seq += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `np${seq}@coboard.test`,
      passwordHash: 'x',
      displayName: `User ${seq}`,
      avatarColor: '#3b82f6',
      role,
    })
    .returning();
  if (!row) throw new Error('seedUser: no row');
  const { token } = await createSession(db, row.id);
  const cookie = `coboard_session=${ctx.app.signCookie(token)}`;
  return { id: row.id, cookie };
}

async function seedProject(creatorId: string): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(projects)
    .values({ name: `Project ${seq}`, key: `NP${seq}`, createdBy: creatorId })
    .returning();
  if (!row) throw new Error('seedProject: no row');
  return row.id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role });
}

/** Insert a task row directly (projectId null → pool task). */
async function seedTask(
  values: Partial<NewTaskRow> & { createdBy: string },
): Promise<string> {
  const [row] = await db
    .insert(tasks)
    .values({ title: 'Task', rank: 'n', status: 'open', projectId: null, ...values })
    .returning();
  if (!row) throw new Error('seedTask: no row');
  return row.id;
}

async function seedClaimant(
  taskId: string,
  userId: string,
  points: number | null = null,
): Promise<void> {
  await db.insert(taskClaimants).values({ taskId, userId, points });
}

async function getTaskRow(id: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0];
}

beforeEach(async () => {
  if (ctx) await ctx.cleanup();
  ctx = await createTestContext();
  db = ctx.db;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe('POST /tasks (unified create)', () => {
  it('creates a no-project (pool) task when projectId is omitted', async () => {
    const u = await seedUser('member');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '池子任务' },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as { task: Task };
    expect(task.projectId).toBeNull();
    expect(task.projectName).toBeNull();
    expect(task.projectKey).toBeNull();
    expect(task.status).toBe('open');
    expect(task.createdBy).toBe(u.id);
  });

  it('creates a project task (with project context) when projectId is supplied', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '项目任务', projectId },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as { task: Task };
    expect(task.projectId).toBe(projectId);
    expect(task.projectName).not.toBeNull();
    expect(task.projectKey).not.toBeNull();
  });

  it('forbids creating a project task in a project the caller is not a member of', async () => {
    const owner = await seedUser('member');
    const outsider = await seedUser('member');
    const projectId = await seedProject(owner.id);
    await addMember(projectId, owner.id, 'lead');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: outsider.cookie, ...CSRF },
      payload: { title: '越权', projectId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unauthenticated pool-task create with 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { ...CSRF },
      payload: { title: '匿名' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /tasks/all (visibility + union)', () => {
  it('shows a pool task to a different user, with null project context', async () => {
    const creator = await seedUser('member');
    const other = await seedUser('member');
    const poolTaskId = await seedTask({ createdBy: creator.id, title: '共享池任务' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/all',
      headers: { cookie: other.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks: list } = res.json() as { tasks: Task[] };
    const pool = list.find((t) => t.id === poolTaskId);
    expect(pool).toBeDefined();
    expect(pool?.projectId).toBeNull();
    expect(pool?.projectName).toBeNull();
    expect(pool?.projectKey).toBeNull();
  });

  it('unions the caller`s project tasks + pool tasks, each with its project context', async () => {
    const me = await seedUser('member');
    const stranger = await seedUser('member');

    // A project I belong to, with a task.
    const myProject = await seedProject(me.id);
    await addMember(myProject, me.id, 'member');
    const myProjectTaskId = await seedTask({
      projectId: myProject,
      createdBy: me.id,
      title: '我的项目任务',
    });

    // A project I do NOT belong to — its task must be hidden.
    const otherProject = await seedProject(stranger.id);
    await addMember(otherProject, stranger.id, 'lead');
    const hiddenTaskId = await seedTask({
      projectId: otherProject,
      createdBy: stranger.id,
      title: '别人项目任务',
    });

    // A shared pool task — always visible.
    const poolTaskId = await seedTask({ createdBy: stranger.id, title: '池任务' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/all',
      headers: { cookie: me.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks: list } = res.json() as { tasks: Task[] };
    const ids = list.map((t) => t.id);

    expect(ids).toContain(myProjectTaskId);
    expect(ids).toContain(poolTaskId);
    expect(ids).not.toContain(hiddenTaskId);

    const mine = list.find((t) => t.id === myProjectTaskId);
    expect(mine?.projectId).toBe(myProject);
    expect(mine?.projectName).not.toBeNull();
    expect(mine?.projectKey).not.toBeNull();

    const pool = list.find((t) => t.id === poolTaskId);
    expect(pool?.projectName).toBeNull();
  });

  it('lets an admin see every project task + the pool', async () => {
    const admin = await seedUser('admin');
    const member = await seedUser('member');
    const projectId = await seedProject(member.id);
    await addMember(projectId, member.id, 'lead');
    const projectTaskId = await seedTask({
      projectId,
      createdBy: member.id,
      title: '某项目任务',
    });
    const poolTaskId = await seedTask({ createdBy: member.id, title: '池任务' });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/tasks/all',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { tasks: list } = res.json() as { tasks: Task[] };
    const ids = list.map((t) => t.id);
    expect(ids).toContain(projectTaskId);
    expect(ids).toContain(poolTaskId);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/tasks/all' });
    expect(res.statusCode).toBe(401);
  });
});

describe('pool task lifecycle (§8 permissions)', () => {
  it('lets any logged-in user claim a pool task', async () => {
    const creator = await seedUser('member');
    const claimer = await seedUser('member');
    const taskId = await seedTask({ createdBy: creator.id });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/claim`,
      headers: { cookie: claimer.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('in_progress');
    expect(task.claimants.map((c) => c.userId)).toEqual([claimer.id]);
  });

  it('lets a claimant deliver a pool task → pending_review', async () => {
    const creator = await seedUser('member');
    const worker = await seedUser('member');
    const taskId = await seedTask({
      createdBy: creator.id,
      status: 'in_progress',
      points: 10,
    });
    await seedClaimant(taskId, worker.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: worker.cookie, ...CSRF },
      payload: { allocations: [{ userId: worker.id, points: 10 }] },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('pending_review');
    expect(task.deliveredBy).toBe(worker.id);
  });

  it('forbids the (non-admin) creator from reviewing their own pool task — pool tasks are admin-reviewed only', async () => {
    const creator = await seedUser('member');
    const worker = await seedUser('member');
    const taskId = await seedTask({
      createdBy: creator.id,
      status: 'pending_review',
      points: 10,
      deliveredBy: worker.id,
      deliveredAt: new Date(),
    });
    await seedClaimant(taskId, worker.id, 10);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: creator.cookie, ...CSRF },
      payload: { decision: 'approve' },
    });
    // A pool task has no project lead, so its creator (a non-lead) must NOT be able
    // to approve it — only a global admin may. The task stays pending_review.
    expect(res.statusCode).toBe(403);
    expect((await getTaskRow(taskId))?.status).toBe('pending_review');
  });

  it('forbids the (non-admin) creator from revoking approval of a done pool task; allows an admin', async () => {
    const creator = await seedUser('member');
    const worker = await seedUser('member');
    const admin = await seedUser('admin');
    const taskId = await seedTask({
      createdBy: creator.id,
      status: 'done',
      points: 6,
      deliveredBy: worker.id,
      deliveredAt: new Date(),
      completedAt: new Date(),
      reviewedBy: admin.id,
    });
    await seedClaimant(taskId, worker.id, 6);

    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/revoke-approval`,
      headers: { cookie: creator.cookie, ...CSRF },
    });
    expect(denied.statusCode).toBe(403);
    expect((await getTaskRow(taskId))?.status).toBe('done');

    const ok = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/revoke-approval`,
      headers: { cookie: admin.cookie, ...CSRF },
    });
    expect(ok.statusCode).toBe(200);
    expect((await getTaskRow(taskId))?.status).toBe('pending_review');
  });

  it('lets a global admin review a pool task they did not create', async () => {
    const creator = await seedUser('member');
    const worker = await seedUser('member');
    const admin = await seedUser('admin');
    const taskId = await seedTask({
      createdBy: creator.id,
      status: 'pending_review',
      points: 4,
      deliveredBy: worker.id,
      deliveredAt: new Date(),
    });
    await seedClaimant(taskId, worker.id, 4);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: admin.cookie, ...CSRF },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('done');
    expect(task.reviewedBy).toBe(admin.id);
  });

  it('forbids a random member (non-creator, non-admin) from reviewing a pool task', async () => {
    const creator = await seedUser('member');
    const worker = await seedUser('member');
    const random = await seedUser('member');
    const taskId = await seedTask({
      createdBy: creator.id,
      status: 'pending_review',
      points: 10,
      deliveredBy: worker.id,
      deliveredAt: new Date(),
    });
    await seedClaimant(taskId, worker.id, 10);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: random.cookie, ...CSRF },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
    expect((await getTaskRow(taskId))?.status).toBe('pending_review');
  });

  it('forbids a random member from editing a pool task; allows the creator', async () => {
    const creator = await seedUser('member');
    const random = await seedUser('member');
    const taskId = await seedTask({ createdBy: creator.id });

    const denied = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: random.cookie, ...CSRF },
      payload: { title: '乱改' },
    });
    expect(denied.statusCode).toBe(403);

    const ok = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: creator.cookie, ...CSRF },
      payload: { title: '改标题' },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('SSE fan-out for pool tasks', () => {
  it('delivers a pool-task event to every subscriber regardless of project set', async () => {
    const creator = await seedUser('member');

    // A subscriber with NO project memberships still receives null-project events.
    const events: { entity: string; type: string; projectId: string | null }[] = [];
    const unsubscribe = ctx.bus.subscribe([], (e) =>
      events.push({ entity: e.entity, type: e.type, projectId: e.projectId }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: creator.cookie, ...CSRF },
      payload: { title: '广播池任务' },
    });
    expect(res.statusCode).toBe(201);
    unsubscribe();

    const taskEvent = events.find((e) => e.entity === 'task' && e.type === 'created');
    expect(taskEvent).toBeDefined();
    expect(taskEvent?.projectId).toBeNull();
  });
});

describe('stats credit completed pool tasks (§8)', () => {
  it('counts a done pool task toward the all-scope leaderboard', async () => {
    const worker = await seedUser('member');
    const at = new Date('2026-06-01T00:00:00.000Z');

    // A completed pool task attributed to the worker (8 points).
    const taskId = await seedTask({
      createdBy: worker.id,
      status: 'done',
      points: 8,
      completedAt: at,
    });
    await seedClaimant(taskId, worker.id, 8);

    // The worker has no project memberships, but pool contributions still count in
    // the no-projectId (all) leaderboard (§8).
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/stats/leaderboard?sort=points',
      headers: { cookie: worker.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as LeaderboardResponse;
    const me = entries.find((e) => e.user.id === worker.id);
    expect(me).toBeDefined();
    expect(me?.completedCount).toBe(1);
    expect(me?.pointsSum).toBe(8);
  });

  it('excludes pool tasks from a specific-project leaderboard', async () => {
    const lead = await seedUser('member');
    const projectId = await seedProject(lead.id);
    await addMember(projectId, lead.id, 'lead');
    const at = new Date('2026-06-01T00:00:00.000Z');

    // One done project task (3 pts) + one done pool task (5 pts), same user.
    const projTask = await seedTask({
      projectId,
      createdBy: lead.id,
      status: 'done',
      points: 3,
      completedAt: at,
    });
    await seedClaimant(projTask, lead.id, 3);
    const poolTask = await seedTask({
      createdBy: lead.id,
      status: 'done',
      points: 5,
      completedAt: at,
    });
    await seedClaimant(poolTask, lead.id, 5);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/stats/leaderboard?projectId=${projectId}&sort=points`,
      headers: { cookie: lead.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { entries } = res.json() as LeaderboardResponse;
    const me = entries.find((e) => e.user.id === lead.id);
    // Project scope counts only the project task (3 pts, 1 done), NOT the pool task.
    expect(me?.completedCount).toBe(1);
    expect(me?.pointsSum).toBe(3);
  });
});
