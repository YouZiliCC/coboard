import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  LeaderboardResponse,
  MyStatsResponse,
  TrendResponse,
} from 'shared';
import { SESSION_COOKIE } from '../src/auth/session.js';
import {
  projectMembers,
  projects,
  sessions,
  taskClaimants,
  tasks,
  users,
  type NewTaskRow,
} from '../src/db/schema.js';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * Contribution-statistics tests (§6.4 / §10; lifecycle v2 §4). Seeds completed
 * tasks with their `task_claimants` shares across several users, dates, and point
 * values, then asserts:
 * - leaderboard ranking + count-vs-points sort switching (per-claimant attribution),
 * - time-range (`completed_at`) filtering,
 * - attribution stability — the claimant share is locked, independent of the
 *   deprecated single-assignee column,
 * - per-user trend buckets,
 * - project-scoped vs all-visible aggregation + membership authorization.
 */

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterAll(async () => {
  await ctx.cleanup();
});

// --- fixtures --------------------------------------------------------------

let rankSeq = 0;
/** Monotonic rank key so each inserted task has a distinct ordering value. */
function nextRank(): string {
  rankSeq += 1;
  return `r${String(rankSeq).padStart(6, '0')}`;
}

interface SeededUser {
  id: string;
  cookie: string;
}

/** Insert an active user and return its id plus a signed session cookie. */
async function seedUser(opts: {
  email: string;
  displayName: string;
  role?: 'admin' | 'member';
}): Promise<SeededUser> {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: opts.email,
      passwordHash: 'x', // not exercised by stats endpoints
      displayName: opts.displayName,
      avatarColor: '#3b82f6',
      role: opts.role ?? 'member',
      isActive: true,
    })
    .returning();
  if (!row) throw new Error('seedUser: insert returned no row');

  const token = `tok-${row.id}`;
  await ctx.db.insert(sessions).values({
    id: token,
    userId: row.id,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    lastSeenAt: new Date(),
  });

  // Sign the token exactly as the cookie plugin would on login.
  const signed = ctx.app.signCookie(token);
  return { id: row.id, cookie: `${SESSION_COOKIE}=${signed}` };
}

async function seedProject(opts: {
  name: string;
  key: string;
  createdBy: string;
}): Promise<string> {
  const [row] = await ctx.db
    .insert(projects)
    .values({ name: opts.name, key: opts.key, createdBy: opts.createdBy })
    .returning();
  if (!row) throw new Error('seedProject: insert returned no row');
  return row.id;
}

async function addMember(projectId: string, userId: string): Promise<void> {
  await ctx.db
    .insert(projectMembers)
    .values({ projectId, userId, role: 'member' });
}

/**
 * Insert a completed (done) task and attribute it to `claimedBy` via a
 * `task_claimants` row carrying the locked points share (lifecycle v2 §4 — the
 * stats source is `task_claimants ⋈ tasks WHERE status='done'`). `points` is the
 * claimant's share; null counts as 0 points but still +1 to the completed count.
 */
async function seedDoneTask(opts: {
  projectId: string;
  createdBy: string;
  completedBy: string;
  completedAt: Date;
  points?: number | null;
}): Promise<string> {
  const values: NewTaskRow = {
    projectId: opts.projectId,
    title: 'done task',
    status: 'done',
    points: opts.points ?? null,
    createdBy: opts.createdBy,
    rank: nextRank(),
    completedAt: opts.completedAt,
  };
  const [row] = await ctx.db.insert(tasks).values(values).returning();
  if (!row) throw new Error('seedDoneTask: insert returned no row');
  await ctx.db.insert(taskClaimants).values({
    taskId: row.id,
    userId: opts.completedBy,
    points: opts.points ?? null,
    claimedAt: opts.completedAt,
  });
  return row.id;
}

/** Truncate all task/project/membership/user rows between tests. */
async function reset(): Promise<void> {
  await ctx.db.delete(taskClaimants);
  await ctx.db.delete(tasks);
  await ctx.db.delete(projectMembers);
  await ctx.db.delete(projects);
  await ctx.db.delete(sessions);
  await ctx.db.delete(users);
  rankSeq = 0;
}

beforeEach(reset);

// --- request helpers -------------------------------------------------------

async function getJson<T>(url: string, cookie: string): Promise<{ status: number; body: T }> {
  const res = await ctx.app.inject({ method: 'GET', url, headers: { cookie } });
  return { status: res.statusCode, body: res.json() as T };
}

// --- tests -----------------------------------------------------------------

describe('GET /api/stats/leaderboard', () => {
  it('ranks users by completed count and switches to points sort', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const alice = await seedUser({ email: 'alice@x.com', displayName: 'Alice' });
    const bob = await seedUser({ email: 'bob@x.com', displayName: 'Bob' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    const base = new Date('2026-06-01T10:00:00.000Z');
    // Alice: 3 tasks, 1 + 2 + null(=0) = 3 points.
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: alice.id, completedAt: base, points: 1 });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: alice.id, completedAt: base, points: 2 });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: alice.id, completedAt: base, points: null });
    // Bob: 2 tasks, 10 + 5 = 15 points.
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: bob.id, completedAt: base, points: 10 });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: bob.id, completedAt: base, points: 5 });

    // Sort by count (default): Alice (3) ahead of Bob (2).
    const byCount = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}&sort=count`,
      admin.cookie,
    );
    expect(byCount.status).toBe(200);
    expect(byCount.body.entries.map((e) => e.user.displayName)).toEqual(['Alice', 'Bob']);
    expect(byCount.body.entries[0]).toMatchObject({ completedCount: 3, pointsSum: 3 });
    expect(byCount.body.entries[1]).toMatchObject({ completedCount: 2, pointsSum: 15 });

    // Sort by points: Bob (15) ahead of Alice (3).
    const byPoints = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}&sort=points`,
      admin.cookie,
    );
    expect(byPoints.body.entries.map((e) => e.user.displayName)).toEqual(['Bob', 'Alice']);
    expect(byPoints.body.entries[0]).toMatchObject({ completedCount: 2, pointsSum: 15 });
  });

  it('treats null points as 0 in the points sum', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const carol = await seedUser({ email: 'carol@x.com', displayName: 'Carol' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    const at = new Date('2026-06-02T10:00:00.000Z');
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: carol.id, completedAt: at, points: null });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: carol.id, completedAt: at, points: null });

    const res = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}`,
      admin.cookie,
    );
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ completedCount: 2, pointsSum: 0 });
  });

  it('filters by completed_at within [from, to]', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const dave = await seedUser({ email: 'dave@x.com', displayName: 'Dave' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: dave.id, completedAt: new Date('2026-05-01T00:00:00.000Z'), points: 1 });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: dave.id, completedAt: new Date('2026-06-10T00:00:00.000Z'), points: 1 });
    await seedDoneTask({ projectId, createdBy: admin.id, completedBy: dave.id, completedAt: new Date('2026-06-20T00:00:00.000Z'), points: 1 });

    const from = '2026-06-01T00:00:00.000Z';
    const to = '2026-06-15T00:00:00.000Z';
    const res = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}&from=${from}&to=${to}`,
      admin.cookie,
    );
    // Only the 2026-06-10 task falls inside the window.
    expect(res.body.entries[0]).toMatchObject({ completedCount: 1, pointsSum: 1 });
  });

  it('keeps attribution stable — locked to the claimant, not the deprecated assignee', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const eve = await seedUser({ email: 'eve@x.com', displayName: 'Eve' });
    const frank = await seedUser({ email: 'frank@x.com', displayName: 'Frank' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    const at = new Date('2026-06-05T10:00:00.000Z');
    const taskId = await seedDoneTask({
      projectId,
      createdBy: admin.id,
      completedBy: eve.id, // claimant share is the locked attribution
      completedAt: at,
      points: 7,
    });

    // Mutating the deprecated single-assignee column must NOT move the credit:
    // contribution is attributed via task_claimants (v2 §4).
    await ctx.db.update(tasks).set({ assigneeId: frank.id }).where(eq(tasks.id, taskId));

    const res = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}`,
      admin.cookie,
    );
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]?.user.displayName).toBe('Eve');
    expect(res.body.entries[0]).toMatchObject({ completedCount: 1, pointsSum: 7 });
  });

  it('credits every claimant of a shared done task with its own share', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const nora = await seedUser({ email: 'nora@x.com', displayName: 'Nora' });
    const omar = await seedUser({ email: 'omar@x.com', displayName: 'Omar' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    const at = new Date('2026-06-08T10:00:00.000Z');
    const [task] = await ctx.db
      .insert(tasks)
      .values({
        projectId,
        title: 'shared done task',
        status: 'done',
        points: 10,
        createdBy: admin.id,
        rank: nextRank(),
        completedAt: at,
      })
      .returning();
    if (!task) throw new Error('insert returned no row');
    // Two claimants split the 10 points 6/4 (locked at deliver).
    await ctx.db.insert(taskClaimants).values([
      { taskId: task.id, userId: nora.id, points: 6, claimedAt: at },
      { taskId: task.id, userId: omar.id, points: 4, claimedAt: at },
    ]);

    const res = await getJson<LeaderboardResponse>(
      `/api/stats/leaderboard?projectId=${projectId}&sort=points`,
      admin.cookie,
    );
    // Each claimant earns +1 completed and their own share.
    expect(res.body.entries.map((e) => e.user.displayName)).toEqual(['Nora', 'Omar']);
    expect(res.body.entries[0]).toMatchObject({ completedCount: 1, pointsSum: 6 });
    expect(res.body.entries[1]).toMatchObject({ completedCount: 1, pointsSum: 4 });
  });

  it('aggregates across all visible projects when no projectId is given', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const member = await seedUser({ email: 'm@x.com', displayName: 'Mia' });
    const projectA = await seedProject({ name: 'A', key: 'PA', createdBy: admin.id });
    const projectB = await seedProject({ name: 'B', key: 'PB', createdBy: admin.id });
    await addMember(projectA, member.id); // member only sees project A

    const at = new Date('2026-06-06T10:00:00.000Z');
    await seedDoneTask({ projectId: projectA, createdBy: admin.id, completedBy: member.id, completedAt: at, points: 2 });
    await seedDoneTask({ projectId: projectB, createdBy: admin.id, completedBy: member.id, completedAt: at, points: 4 });

    // Member: only project A counted (2 points, 1 task).
    const asMember = await getJson<LeaderboardResponse>('/api/stats/leaderboard', member.cookie);
    expect(asMember.body.entries).toHaveLength(1);
    expect(asMember.body.entries[0]).toMatchObject({ completedCount: 1, pointsSum: 2 });

    // Admin: all projects counted (6 points, 2 tasks).
    const asAdmin = await getJson<LeaderboardResponse>('/api/stats/leaderboard', admin.cookie);
    const mia = asAdmin.body.entries.find((e) => e.user.displayName === 'Mia');
    expect(mia).toMatchObject({ completedCount: 2, pointsSum: 6 });
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/stats/leaderboard' });
    expect(res.statusCode).toBe(401);
  });

  it('forbids a non-member from a project-scoped leaderboard with 403', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const outsider = await seedUser({ email: 'out@x.com', displayName: 'Outsider' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: admin.id });

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/stats/leaderboard?projectId=${projectId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('GET /api/stats/me', () => {
  it('returns the caller own completed count and points across projects', async () => {
    const admin = await seedUser({ email: 'admin@x.com', displayName: 'Admin', role: 'admin' });
    const grace = await seedUser({ email: 'grace@x.com', displayName: 'Grace' });
    const projectA = await seedProject({ name: 'A', key: 'PA', createdBy: admin.id });
    const projectB = await seedProject({ name: 'B', key: 'PB', createdBy: admin.id });
    await addMember(projectA, grace.id);

    const at = new Date('2026-06-07T10:00:00.000Z');
    await seedDoneTask({ projectId: projectA, createdBy: admin.id, completedBy: grace.id, completedAt: at, points: 3 });
    await seedDoneTask({ projectId: projectB, createdBy: admin.id, completedBy: grace.id, completedAt: at, points: null });
    // A task completed by someone else must not be counted for Grace.
    await seedDoneTask({ projectId: projectA, createdBy: admin.id, completedBy: admin.id, completedAt: at, points: 99 });

    const res = await getJson<MyStatsResponse>('/api/stats/me', grace.cookie);
    expect(res.status).toBe(200);
    // Grace owns 2 completed tasks; null points → 0, so sum = 3.
    expect(res.body).toEqual({ completedCount: 2, pointsSum: 3 });
  });

  it('honors the time-range filter', async () => {
    const heidi = await seedUser({ email: 'heidi@x.com', displayName: 'Heidi', role: 'admin' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: heidi.id });

    await seedDoneTask({ projectId, createdBy: heidi.id, completedBy: heidi.id, completedAt: new Date('2026-01-01T00:00:00.000Z'), points: 5 });
    await seedDoneTask({ projectId, createdBy: heidi.id, completedBy: heidi.id, completedAt: new Date('2026-06-12T00:00:00.000Z'), points: 5 });

    const res = await getJson<MyStatsResponse>(
      '/api/stats/me?from=2026-06-01T00:00:00.000Z&to=2026-06-30T00:00:00.000Z',
      heidi.cookie,
    );
    expect(res.body).toEqual({ completedCount: 1, pointsSum: 5 });
  });
});

describe('GET /api/stats/trend', () => {
  it('buckets completed tasks per day in ascending order', async () => {
    const ivan = await seedUser({ email: 'ivan@x.com', displayName: 'Ivan', role: 'admin' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: ivan.id });

    // Day 1: 2 tasks (3 + 0 points); Day 2: 1 task (4 points).
    await seedDoneTask({ projectId, createdBy: ivan.id, completedBy: ivan.id, completedAt: new Date('2026-06-10T08:00:00.000Z'), points: 3 });
    await seedDoneTask({ projectId, createdBy: ivan.id, completedBy: ivan.id, completedAt: new Date('2026-06-10T20:00:00.000Z'), points: null });
    await seedDoneTask({ projectId, createdBy: ivan.id, completedBy: ivan.id, completedAt: new Date('2026-06-11T09:00:00.000Z'), points: 4 });

    const res = await getJson<TrendResponse>(
      `/api/stats/trend?userId=${ivan.id}&bucket=day`,
      ivan.cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([
      { date: '2026-06-10', completedCount: 2, pointsSum: 3 },
      { date: '2026-06-11', completedCount: 1, pointsSum: 4 },
    ]);
  });

  it('defaults userId to the caller', async () => {
    const judy = await seedUser({ email: 'judy@x.com', displayName: 'Judy', role: 'admin' });
    const projectId = await seedProject({ name: 'P', key: 'P1', createdBy: judy.id });
    await seedDoneTask({ projectId, createdBy: judy.id, completedBy: judy.id, completedAt: new Date('2026-06-13T08:00:00.000Z'), points: 2 });

    const res = await getJson<TrendResponse>('/api/stats/trend', judy.cookie);
    expect(res.body.points).toEqual([
      { date: '2026-06-13', completedCount: 1, pointsSum: 2 },
    ]);
  });
});
