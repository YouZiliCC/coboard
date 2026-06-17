import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Task } from 'shared';
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
import { rankBetween } from '../src/services/taskService.js';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * Task / board feature tests (lifecycle v2 §1–§4, §10). Covers the characteristic
 * domain logic of the multi-claimant + deliver/review model: claim adds to the
 * claimant set (idempotent, multi-claimant), release removes a claimant, dispatch
 * adds a claimant, the deliver → review (approve / reject) flow with points
 * allocation, and the permission matrix.
 *
 * Auth: tests authenticate by seeding a session row directly and signing the
 * session cookie — exactly what the production auth pre-handler reads.
 */

const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

let ctx: TestContext;
let db: Database;

/** Counter to keep seeded emails/keys unique across tests. */
let seq = 0;

interface SeededUser {
  id: string;
  cookie: string;
}

/** Insert a user and return its id plus a signed session cookie. */
async function seedUser(role: 'admin' | 'member' = 'member'): Promise<SeededUser> {
  seq += 1;
  const [row] = await db
    .insert(users)
    .values({
      email: `u${seq}@coboard.test`,
      passwordHash: 'x', // hash irrelevant; we authenticate via session row
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

/** Insert a project created by `creatorId`. */
async function seedProject(creatorId: string): Promise<string> {
  seq += 1;
  const [row] = await db
    .insert(projects)
    .values({
      name: `Project ${seq}`,
      key: `P${seq}`,
      createdBy: creatorId,
    })
    .returning();
  if (!row) throw new Error('seedProject: no row');
  return row.id;
}

/** Add a membership row. */
async function addMember(
  projectId: string,
  userId: string,
  role: 'lead' | 'member' = 'member',
): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role });
}

/** Insert a task row directly (bypassing the API) for setup. */
async function seedTask(values: Partial<NewTaskRow> & {
  projectId: string;
  createdBy: string;
}): Promise<Task['id']> {
  const [row] = await db
    .insert(tasks)
    .values({
      title: 'Task',
      rank: 'n',
      status: 'open',
      ...values,
    })
    .returning();
  if (!row) throw new Error('seedTask: no row');
  return row.id;
}

async function getTaskRow(id: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
  return rows[0];
}

/** Seed a claimant row directly (lifecycle v2 §2). */
async function seedClaimant(
  taskId: string,
  userId: string,
  points: number | null = null,
): Promise<void> {
  await db.insert(taskClaimants).values({ taskId, userId, points });
}

/** Load the claimant rows for a task. */
async function getClaimants(taskId: string) {
  return db.select().from(taskClaimants).where(eq(taskClaimants.taskId, taskId));
}

beforeEach(async () => {
  // Fresh database per test for isolation.
  if (ctx) await ctx.cleanup();
  ctx = await createTestContext();
  db = ctx.db;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe('rankBetween (intra-column ordering key)', () => {
  it('produces a key strictly between its neighbours', () => {
    const a = rankBetween(null, null);
    const before = rankBetween(null, a);
    const after = rankBetween(a, null);
    expect(before < a).toBe(true);
    expect(a < after).toBe(true);

    const mid = rankBetween(before, a);
    expect(before < mid).toBe(true);
    expect(mid < a).toBe(true);
  });

  it('keeps order stable across repeated insertions between two keys', () => {
    let lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 30; i += 1) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      hi = mid; // keep squeezing between lo and the newest mid
    }
  });
});

describe('GET /projects/:id/tasks (board)', () => {
  it('returns all tasks for members and 403 for non-members', async () => {
    const owner = await seedUser('member');
    const projectId = await seedProject(owner.id);
    await addMember(projectId, owner.id, 'lead');
    await seedTask({ projectId, createdBy: owner.id, title: 'A', rank: 'a' });
    await seedTask({ projectId, createdBy: owner.id, title: 'B', rank: 'b' });

    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: owner.cookie },
    });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { tasks: Task[] };
    expect(body.tasks).toHaveLength(2);

    const outsider = await seedUser('member');
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: outsider.cookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('POST /projects/:id/tasks (create)', () => {
  it('defaults to open/unassigned', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '写文档' },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('open');
    expect(task.claimants).toHaveLength(0);
    expect(task.priority).toBe('medium');
  });

  it('dispatches to in_progress with a claimant when assigneeId is given', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '上线', assigneeId: u.id, points: 5, priority: 'high' },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('in_progress');
    expect(task.claimants.map((c) => c.userId)).toEqual([u.id]);
    expect(task.points).toBe(5);
    expect(task.priority).toBe('high');
  });
});

describe('POST /tasks/:id/claim', () => {
  it('claims an open task → caller joins claimants, status=in_progress', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: u.id });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/claim`,
      headers: { cookie: u.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.claimants.map((c) => c.userId)).toEqual([u.id]);
    expect(task.status).toBe('in_progress');
  });

  it('lets multiple members claim the same task (multi-claimant)', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(a.id);
    await addMember(projectId, a.id, 'member');
    await addMember(projectId, b.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: a.id });

    // Fire both claims concurrently; both should succeed (the set absorbs both).
    const [r1, r2] = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/claim`,
        headers: { cookie: a.cookie, ...CSRF },
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/api/tasks/${taskId}/claim`,
        headers: { cookie: b.cookie, ...CSRF },
      }),
    ]);

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const row = await getTaskRow(taskId);
    expect(row?.status).toBe('in_progress');
    const claimants = await getClaimants(taskId);
    expect(claimants.map((c) => c.userId).sort()).toEqual([a.id, b.id].sort());
  });

  it('is idempotent: re-claiming an already-claimed task keeps a single membership', async () => {
    const a = await seedUser('member');
    const projectId = await seedProject(a.id);
    await addMember(projectId, a.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: a.id,
      status: 'in_progress',
    });
    await seedClaimant(taskId, a.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/claim`,
      headers: { cookie: a.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const claimants = await getClaimants(taskId);
    expect(claimants).toHaveLength(1);
  });

  it('returns 409 when claiming a done task', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(a.id);
    await addMember(projectId, a.id, 'member');
    await addMember(projectId, b.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: a.id,
      status: 'done',
    });
    await seedClaimant(taskId, a.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/claim`,
      headers: { cookie: b.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('POST /tasks/:id/claim — claim limits (claim-limits)', () => {
  const claim = (taskId: string, u: SeededUser) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/claim`,
      headers: { cookie: u.cookie, ...CSRF },
    });

  it('keeps an under-min task in 待认领 until the lower bound is met', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const c = await seedUser('member');
    const projectId = await seedProject(a.id);
    for (const u of [a, b, c]) await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: a.id, minClaimants: 3 });

    const r1 = await claim(taskId, a);
    expect((r1.json() as { task: Task }).task.status).toBe('open'); // 1/3 未达下限
    const r2 = await claim(taskId, b);
    expect((r2.json() as { task: Task }).task.status).toBe('open'); // 2/3 未达下限
    const r3 = await claim(taskId, c);
    expect((r3.json() as { task: Task }).task.status).toBe('in_progress'); // 3/3 达标
  });

  it('rejects a new claim once the upper bound is reached', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const c = await seedUser('member');
    const projectId = await seedProject(a.id);
    for (const u of [a, b, c]) await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: a.id, maxClaimants: 2 });

    expect((await claim(taskId, a)).statusCode).toBe(200);
    expect((await claim(taskId, b)).statusCode).toBe(200);
    expect((await claim(taskId, c)).statusCode).toBe(409); // 已达领取人数上限
  });

  it('still lets an existing claimant re-claim at the upper bound (idempotent)', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(a.id);
    for (const u of [a, b]) await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: a.id, maxClaimants: 2 });
    await claim(taskId, a);
    await claim(taskId, b); // full
    expect((await claim(taskId, a)).statusCode).toBe(200);
  });
});

describe('POST /tasks/:id/release', () => {
  it('lets a sole claimant release → task returns to open with no claimants', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: u.id,
      status: 'in_progress',
    });
    await seedClaimant(taskId, u.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: u.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.claimants).toHaveLength(0);
    expect(task.status).toBe('open');
  });

  it('keeps the task in_progress while other claimants remain', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(a.id);
    await addMember(projectId, a.id, 'member');
    await addMember(projectId, b.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: a.id,
      status: 'in_progress',
    });
    await seedClaimant(taskId, a.id);
    await seedClaimant(taskId, b.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: a.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('in_progress');
    expect(task.claimants.map((c) => c.userId)).toEqual([b.id]);
  });

  it('drops back to 待认领 when a release leaves claimants below the lower bound (claim-limits)', async () => {
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(a.id);
    await addMember(projectId, a.id, 'member');
    await addMember(projectId, b.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: a.id,
      status: 'in_progress',
      minClaimants: 2,
    });
    await seedClaimant(taskId, a.id);
    await seedClaimant(taskId, b.id);

    // One of two claimants leaves → 1 remains < min 2 → returns to 待认领.
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: b.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('open');
    expect(task.claimants.map((c) => c.userId)).toEqual([a.id]);
  });

  it('refuses to release a done task (keeps the completed claimant record intact)', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: u.id, status: 'done' });
    await seedClaimant(taskId, u.id, 5);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: u.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(409);
    const row = await getTaskRow(taskId);
    expect(row?.status).toBe('done'); // unchanged
  });

  it('lets a lead remove another claimant via userId', async () => {
    const lead = await seedUser('member');
    const worker = await seedUser('member');
    const projectId = await seedProject(lead.id);
    await addMember(projectId, lead.id, 'lead');
    await addMember(projectId, worker.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: lead.id,
      status: 'in_progress',
    });
    await seedClaimant(taskId, worker.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: lead.cookie, ...CSRF },
      payload: { userId: worker.id },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.claimants).toHaveLength(0);
    expect(task.status).toBe('open');
  });

  it('forbids a plain member from removing another claimant', async () => {
    const owner = await seedUser('member');
    const claimant = await seedUser('member');
    const other = await seedUser('member');
    const projectId = await seedProject(owner.id);
    await addMember(projectId, claimant.id, 'member');
    await addMember(projectId, other.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: owner.id,
      status: 'in_progress',
    });
    await seedClaimant(taskId, claimant.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/release`,
      headers: { cookie: other.cookie, ...CSRF },
      payload: { userId: claimant.id },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /tasks/:id/assign (dispatch)', () => {
  it('lets a lead assign and moves an open task to in_progress', async () => {
    const lead = await seedUser('member');
    const worker = await seedUser('member');
    const projectId = await seedProject(lead.id);
    await addMember(projectId, lead.id, 'lead');
    await addMember(projectId, worker.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: lead.id });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/assign`,
      headers: { cookie: lead.cookie, ...CSRF },
      payload: { assigneeId: worker.id },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.claimants.map((c) => c.userId)).toEqual([worker.id]);
    expect(task.status).toBe('in_progress');
  });

  it('forbids a plain member from dispatching', async () => {
    const member = await seedUser('member');
    const worker = await seedUser('member');
    const projectId = await seedProject(member.id);
    await addMember(projectId, member.id, 'member');
    await addMember(projectId, worker.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: member.id });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/assign`,
      headers: { cookie: member.cookie, ...CSRF },
      payload: { assigneeId: worker.id },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('PATCH /tasks/:id (status transitions)', () => {
  it('allows the direct open → in_progress board move when the lower bound is met', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: u.id, status: 'open' });
    await seedClaimant(taskId, u.id); // 1 claimant ≥ default min 1

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { status: 'in_progress' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('in_progress');
  });

  it('rejects a manual open → in_progress move below the lower bound (claim-limits)', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    // minClaimants 2 with no claimants → must stay in 待认领.
    const taskId = await seedTask({ projectId, createdBy: u.id, status: 'open', minClaimants: 2 });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { status: 'in_progress' },
    });
    expect(res.statusCode).toBe(400);
    expect((await getTaskRow(taskId))?.status).toBe('open');
  });

  it('allows the direct in_progress → open board move', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: u.id,
      status: 'in_progress',
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { status: 'open' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('open');
  });

  it('rejects jumping straight to done via PATCH (deliver/review owns it)', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: u.id,
      status: 'in_progress',
    });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { status: 'done' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids editing a task you neither created nor are assigned to', async () => {
    const owner = await seedUser('member');
    const other = await seedUser('member');
    const projectId = await seedProject(owner.id);
    await addMember(projectId, owner.id, 'member');
    await addMember(projectId, other.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: owner.id });

    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: other.cookie, ...CSRF },
      payload: { title: '改个标题' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('deliver → review lifecycle (§3)', () => {
  /** Seed a project with a lead + two members and an in_progress task they claim. */
  async function seedDeliverable(opts: { points?: number | null } = {}) {
    const lead = await seedUser('member');
    const a = await seedUser('member');
    const b = await seedUser('member');
    const projectId = await seedProject(lead.id);
    await addMember(projectId, lead.id, 'lead');
    await addMember(projectId, a.id, 'member');
    await addMember(projectId, b.id, 'member');
    const taskId = await seedTask({
      projectId,
      createdBy: lead.id,
      status: 'in_progress',
      points: opts.points === undefined ? 10 : opts.points,
    });
    await seedClaimant(taskId, a.id);
    await seedClaimant(taskId, b.id);
    return { lead, a, b, projectId, taskId };
  }

  it('delivers with allocations summing to the task points → pending_review', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: 10 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('pending_review');
    expect(task.deliveredBy).toBe(a.id);
    expect(task.deliveredAt).not.toBeNull();
    const shares = Object.fromEntries(task.claimants.map((c) => [c.userId, c.points]));
    expect(shares[a.id]).toBe(6);
    expect(shares[b.id]).toBe(4);
  });

  it('rejects a delivery whose allocations do not sum to the task points', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: 10 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 5 }, // sums to 11 ≠ 10
      ] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a delivery that omits a current claimant', async () => {
    const { a, taskId } = await seedDeliverable({ points: 10 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [{ userId: a.id, points: 10 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a delivery that allocates to a non-claimant', async () => {
    const { a, b, lead, taskId } = await seedDeliverable({ points: 10 });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 4 },
        { userId: b.id, points: 3 },
        { userId: lead.id, points: 3 }, // lead is not a claimant
      ] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('uses totalPoints and writes it back when the task has no points', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: null });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: {
        totalPoints: 8,
        allocations: [
          { userId: a.id, points: 5 },
          { userId: b.id, points: 3 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('pending_review');
    expect(task.points).toBe(8);
  });

  it('requires totalPoints when the task has no points', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: null });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 5 },
        { userId: b.id, points: 3 },
      ] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('forbids delivering a task you neither claim nor lead', async () => {
    const { taskId } = await seedDeliverable({ points: 10 });
    const outsider = await seedUser('member');
    // Add the outsider to the project so they pass the visibility guard but are
    // neither a claimant nor a lead.
    const row = await getTaskRow(taskId);
    await addMember(row!.projectId, outsider.id, 'member');

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: outsider.cookie, ...CSRF },
      payload: { allocations: [{ userId: outsider.id, points: 10 }] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('approves a delivered task → done, completed_at set, reviewer recorded', async () => {
    const { lead, a, b, taskId } = await seedDeliverable({ points: 10 });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: lead.cookie, ...CSRF },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('done');
    expect(task.completedAt).not.toBeNull();
    expect(task.reviewedBy).toBe(lead.id);
    // Shares stay locked at approval.
    const shares = Object.fromEntries(task.claimants.map((c) => [c.userId, c.points]));
    expect(shares[a.id]).toBe(6);
    expect(shares[b.id]).toBe(4);
  });

  it('rejects a delivered task → back to in_progress with points cleared', async () => {
    const { lead, a, b, taskId } = await seedDeliverable({ points: 10 });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: lead.cookie, ...CSRF },
      payload: { decision: 'reject', comment: '需要补充测试' },
    });
    expect(res.statusCode).toBe(200);
    const { task } = res.json() as { task: Task };
    expect(task.status).toBe('in_progress');
    expect(task.deliveredAt).toBeNull();
    expect(task.deliveredBy).toBeNull();
    expect(task.reviewedBy).toBe(lead.id);
    // Each claimant's share is cleared back to null on reject.
    expect(task.claimants.every((c) => c.points === null)).toBe(true);
  });

  it('forbids a plain member from reviewing', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: 10 });
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/review`,
      headers: { cookie: b.cookie, ...CSRF },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects delivering a task that is not in_progress', async () => {
    const { a, b, taskId } = await seedDeliverable({ points: 10 });
    // Move it to pending_review first.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/deliver`,
      headers: { cookie: a.cookie, ...CSRF },
      payload: { allocations: [
        { userId: a.id, points: 6 },
        { userId: b.id, points: 4 },
      ] },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('DELETE /tasks/:id', () => {
  it('lets the creator delete', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: u.id });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(204);
    expect(await getTaskRow(taskId)).toBeUndefined();
  });

  it('forbids a non-creator member from deleting', async () => {
    const owner = await seedUser('member');
    const other = await seedUser('member');
    const projectId = await seedProject(owner.id);
    await addMember(projectId, owner.id, 'member');
    await addMember(projectId, other.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: owner.id });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: other.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets a global admin delete any task', async () => {
    const member = await seedUser('member');
    const admin = await seedUser('admin');
    const projectId = await seedProject(member.id);
    await addMember(projectId, member.id, 'member');
    const taskId = await seedTask({ projectId, createdBy: member.id });

    const res = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: admin.cookie, ...CSRF },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('realtime bus', () => {
  it('publishes a task event after a mutation', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');

    const events: { entity: string; type: string }[] = [];
    const unsubscribe = ctx.bus.subscribe([projectId], (e) =>
      events.push({ entity: e.entity, type: e.type }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '发事件' },
    });
    expect(res.statusCode).toBe(201);
    unsubscribe();

    // We expect at least an activity event (created) and a task event (created).
    expect(events.some((e) => e.entity === 'task' && e.type === 'created')).toBe(true);
    expect(events.some((e) => e.entity === 'activity' && e.type === 'created')).toBe(true);
  });
});
