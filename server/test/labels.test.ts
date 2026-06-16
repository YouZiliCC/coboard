import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Label, LabelResponse, LabelsResponse, Task, TaskResponse } from 'shared';
import type { Database } from '../src/db/index.js';
import {
  labels as labelsTable,
  projectMembers,
  projects,
  taskLabels,
  tasks,
  users,
} from '../src/db/schema.js';
import { createSession } from '../src/auth/session.js';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * Task-labels feature tests. Covers the global label catalog (create/list, duplicate
 * 409, admin-only rename/delete) and assigning labels to a task via create + via
 * patch (REPLACE semantics), labels surfacing in the task/board payload, and that
 * deleting a label cascades it off tasks.
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
      email: `lbl${seq}@coboard.test`,
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
    .values({ name: `Project ${seq}`, key: `LP${seq}`, createdBy: creatorId })
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

async function createLabel(
  cookie: string,
  name: string,
  color = '#ef4444',
): Promise<Label> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/api/labels',
    headers: { cookie, ...CSRF },
    payload: { name, color },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as LabelResponse).label;
}

beforeEach(async () => {
  if (ctx) await ctx.cleanup();
  ctx = await createTestContext();
  db = ctx.db;
  seq = 0;
});

afterAll(async () => {
  if (ctx) await ctx.cleanup();
});

describe('label catalog', () => {
  it('creates a label and lists it back', async () => {
    const u = await seedUser('member');
    const label = await createLabel(u.cookie, '前端', '#3b82f6');
    expect(label.name).toBe('前端');
    expect(label.color).toBe('#3b82f6');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/labels',
      headers: { cookie: u.cookie },
    });
    expect(res.statusCode).toBe(200);
    const { labels } = res.json() as LabelsResponse;
    expect(labels.map((l) => l.name)).toContain('前端');
  });

  it('rejects a duplicate label name with 409', async () => {
    const u = await seedUser('member');
    await createLabel(u.cookie, '重复');
    const dup = await ctx.app.inject({
      method: 'POST',
      url: '/api/labels',
      headers: { cookie: u.cookie, ...CSRF },
      payload: { name: '重复', color: '#10b981' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('requires admin to PATCH and DELETE a label (member → 403)', async () => {
    const admin = await seedUser('admin');
    const member = await seedUser('member');
    const label = await createLabel(member.cookie, '紧急', '#ef4444');

    // member cannot rename
    const memberPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/labels/${label.id}`,
      headers: { cookie: member.cookie, ...CSRF },
      payload: { color: '#000000' },
    });
    expect(memberPatch.statusCode).toBe(403);

    // member cannot delete
    const memberDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/labels/${label.id}`,
      headers: { cookie: member.cookie, ...CSRF },
    });
    expect(memberDelete.statusCode).toBe(403);

    // admin can rename
    const adminPatch = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/labels/${label.id}`,
      headers: { cookie: admin.cookie, ...CSRF },
      payload: { name: '高优先', color: '#f59e0b' },
    });
    expect(adminPatch.statusCode).toBe(200);
    expect((adminPatch.json() as LabelResponse).label.name).toBe('高优先');

    // admin can delete
    const adminDelete = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/labels/${label.id}`,
      headers: { cookie: admin.cookie, ...CSRF },
    });
    expect(adminDelete.statusCode).toBe(204);
  });
});

describe('task labels (assign / replace / cascade)', () => {
  it('assigns labels on task create and surfaces them in the payload', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const a = await createLabel(u.cookie, 'A', '#ef4444');
    const b = await createLabel(u.cookie, 'B', '#3b82f6');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: '带标签', projectId, labelIds: [a.id, b.id] },
    });
    expect(res.statusCode).toBe(201);
    const { task } = res.json() as TaskResponse;
    expect(task.labels.map((l) => l.id).sort()).toEqual([a.id, b.id].sort());

    // It also appears on the board payload (batch-loaded, no N+1).
    const board = await ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: u.cookie },
    });
    const boardTask = (board.json() as { tasks: Task[] }).tasks.find(
      (t) => t.id === task.id,
    );
    expect(boardTask?.labels.map((l) => l.name).sort()).toEqual(['A', 'B']);
  });

  it('PATCH labelIds replaces the task label set (replace semantics)', async () => {
    const u = await seedUser('member');
    const projectId = await seedProject(u.id);
    await addMember(projectId, u.id, 'member');
    const a = await createLabel(u.cookie, 'A', '#ef4444');
    const b = await createLabel(u.cookie, 'B', '#3b82f6');
    const c = await createLabel(u.cookie, 'C', '#10b981');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: u.cookie, ...CSRF },
      payload: { title: 'T', projectId, labelIds: [a.id, b.id] },
    });
    const taskId = (created.json() as TaskResponse).task.id;

    // Replace {A,B} with {C}.
    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { labelIds: [c.id] },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as TaskResponse).task.labels.map((l) => l.id)).toEqual([
      c.id,
    ]);

    // Clearing with an empty array removes all labels.
    const cleared = await ctx.app.inject({
      method: 'PATCH',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: u.cookie, ...CSRF },
      payload: { labelIds: [] },
    });
    expect(cleared.statusCode).toBe(200);
    expect((cleared.json() as TaskResponse).task.labels).toHaveLength(0);
  });

  it('deleting a label removes it from tasks (cascade)', async () => {
    const admin = await seedUser('admin');
    const projectId = await seedProject(admin.id);
    await addMember(projectId, admin.id, 'lead');
    const a = await createLabel(admin.cookie, 'A', '#ef4444');

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { cookie: admin.cookie, ...CSRF },
      payload: { title: 'T', projectId, labelIds: [a.id] },
    });
    const taskId = (created.json() as TaskResponse).task.id;

    const del = await ctx.app.inject({
      method: 'DELETE',
      url: `/api/labels/${a.id}`,
      headers: { cookie: admin.cookie, ...CSRF },
    });
    expect(del.statusCode).toBe(204);

    // The join row is gone, and the task now has no labels.
    const joins = await db.select().from(taskLabels).where(eq(taskLabels.taskId, taskId));
    expect(joins).toHaveLength(0);

    const get = await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
      headers: { cookie: admin.cookie },
    });
    expect((get.json() as TaskResponse).task.labels).toHaveLength(0);

    const remaining = await db.select().from(labelsTable);
    expect(remaining).toHaveLength(0);
  });
});
