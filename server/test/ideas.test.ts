import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  IdeaResponse,
  IdeasResponse,
  IdeasWithContextResponse,
  LeaderboardResponse,
  MyStatsResponse,
  ProjectRole,
} from 'shared';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import {
  ideas,
  projectMembers,
  projects,
  tasks,
  users,
  type UserRow,
} from '../src/db/schema.js';

/**
 * Idea / inspiration tests (§7.1). Covers post/list, the cross-project 灵感区
 * listing + status filter, the lead/admin adopt (sets points + status) and reject
 * mutations, the member-cannot-adopt 403, and that adopted reward points are
 * credited to the author's leaderboard / me points (folded into pointsSum +
 * surfaced as the rewardPoints breakdown).
 */

let seq = 0;

async function makeUser(
  ctx: TestContext,
  overrides: Partial<{ role: 'admin' | 'member'; displayName: string }> = {},
): Promise<UserRow> {
  seq += 1;
  const [row] = await ctx.db
    .insert(users)
    .values({
      email: `idea-user${seq}@example.com`,
      passwordHash: 'x',
      displayName: overrides.displayName ?? `用户${seq}`,
      avatarColor: '#3b82f6',
      role: overrides.role ?? 'member',
    })
    .returning();
  if (!row) throw new Error('failed to insert user');
  return row;
}

async function makeProject(ctx: TestContext, createdBy: string): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(projects)
    .values({ name: `项目${seq}`, key: `IPRJ${seq}`, createdBy })
    .returning();
  if (!row) throw new Error('failed to insert project');
  return row.id;
}

async function addMember(
  ctx: TestContext,
  projectId: string,
  userId: string,
  role: ProjectRole = 'member',
): Promise<void> {
  await ctx.db.insert(projectMembers).values({ projectId, userId, role });
}

async function makeTask(
  ctx: TestContext,
  projectId: string,
  createdBy: string,
): Promise<string> {
  seq += 1;
  const [row] = await ctx.db
    .insert(tasks)
    .values({ projectId, title: `任务${seq}`, createdBy, rank: `a${seq}` })
    .returning();
  if (!row) throw new Error('failed to insert task');
  return row.id;
}

async function authCookie(ctx: TestContext, userId: string): Promise<string> {
  const { token } = await createSession(ctx.db, userId);
  const signed = ctx.app.signCookie(token);
  return `${SESSION_COOKIE}=${signed}`;
}

function headers(cookie: string): Record<string, string> {
  return { cookie, 'x-requested-with': 'fetch' };
}

describe('ideas / inspiration', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  afterEach(async () => {
    await ctx.db.delete(ideas);
    await ctx.db.delete(tasks);
    await ctx.db.delete(projectMembers);
    await ctx.db.delete(projects);
    await ctx.db.delete(users);
    seq = 0;
  });

  it('posts an idea on a task and lists it back (newest first)', async () => {
    const author = await makeUser(ctx);
    const projectId = await makeProject(ctx, author.id);
    await addMember(ctx, projectId, author.id, 'member');
    const taskId = await makeTask(ctx, projectId, author.id);
    const cookie = await authCookie(ctx, author.id);

    const first = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(cookie),
      payload: { body: '第一个想法' },
    });
    expect(first.statusCode).toBe(201);
    const posted = first.json() as IdeasResponse;
    expect(posted.ideas).toHaveLength(1);
    expect(posted.ideas[0]?.body).toBe('第一个想法');
    expect(posted.ideas[0]?.status).toBe('pending');
    expect(posted.ideas[0]?.rewardPoints).toBeNull();
    expect(posted.ideas[0]?.author.id).toBe(author.id);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(cookie),
      payload: { body: '第二个想法' },
    });

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(cookie),
    });
    expect(listRes.statusCode).toBe(200);
    const listed = listRes.json() as IdeasResponse;
    expect(listed.ideas).toHaveLength(2);
    // Newest first.
    expect(listed.ideas[0]?.body).toBe('第二个想法');
    expect(listed.ideas[1]?.body).toBe('第一个想法');
  });

  it('forbids a non-member from listing or posting ideas (403)', async () => {
    const owner = await makeUser(ctx);
    const outsider = await makeUser(ctx);
    const projectId = await makeProject(ctx, owner.id);
    await addMember(ctx, projectId, owner.id, 'member');
    const taskId = await makeTask(ctx, projectId, owner.id);
    const outsiderCookie = await authCookie(ctx, outsider.id);

    const listRes = await ctx.app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(outsiderCookie),
    });
    expect(listRes.statusCode).toBe(403);

    const postRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(outsiderCookie),
      payload: { body: '不该出现' },
    });
    expect(postRes.statusCode).toBe(403);
  });

  it('rejects an empty idea body with 400', async () => {
    const author = await makeUser(ctx);
    const projectId = await makeProject(ctx, author.id);
    await addMember(ctx, projectId, author.id, 'member');
    const taskId = await makeTask(ctx, projectId, author.id);
    const cookie = await authCookie(ctx, author.id);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(cookie),
      payload: { body: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('lets a project lead adopt an idea — sets status + reward points + adopter', async () => {
    const lead = await makeUser(ctx);
    const member = await makeUser(ctx);
    const projectId = await makeProject(ctx, lead.id);
    await addMember(ctx, projectId, lead.id, 'lead');
    await addMember(ctx, projectId, member.id, 'member');
    const taskId = await makeTask(ctx, projectId, lead.id);
    const memberCookie = await authCookie(ctx, member.id);
    const leadCookie = await authCookie(ctx, lead.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(memberCookie),
      payload: { body: '值得采纳的想法' },
    });
    const ideaId = (created.json() as IdeasResponse).ideas[0]?.id;
    expect(ideaId).toBeDefined();

    const adoptRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(leadCookie),
      payload: { rewardPoints: 8 },
    });
    expect(adoptRes.statusCode).toBe(200);
    const adopted = (adoptRes.json() as IdeaResponse).idea;
    expect(adopted.status).toBe('adopted');
    expect(adopted.rewardPoints).toBe(8);
    expect(adopted.adoptedBy).toBe(lead.id);

    // Re-adopting updates the reward points (idempotent-safe).
    const readopt = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(leadCookie),
      payload: { rewardPoints: 12 },
    });
    expect(readopt.statusCode).toBe(200);
    expect((readopt.json() as IdeaResponse).idea.rewardPoints).toBe(12);
  });

  it('forbids a plain member from adopting an idea (403)', async () => {
    const lead = await makeUser(ctx);
    const member = await makeUser(ctx);
    const projectId = await makeProject(ctx, lead.id);
    await addMember(ctx, projectId, lead.id, 'lead');
    await addMember(ctx, projectId, member.id, 'member');
    const taskId = await makeTask(ctx, projectId, lead.id);
    const memberCookie = await authCookie(ctx, member.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(memberCookie),
      payload: { body: '成员的想法' },
    });
    const ideaId = (created.json() as IdeasResponse).ideas[0]?.id;

    const adoptRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(memberCookie),
      payload: { rewardPoints: 5 },
    });
    expect(adoptRes.statusCode).toBe(403);

    // The idea must remain pending.
    const rows = await ctx.db.select().from(ideas).where(eq(ideas.id, ideaId!));
    expect(rows[0]?.status).toBe('pending');
  });

  it('lets a lead reject an idea — clears reward points', async () => {
    const lead = await makeUser(ctx);
    const member = await makeUser(ctx);
    const projectId = await makeProject(ctx, lead.id);
    await addMember(ctx, projectId, lead.id, 'lead');
    await addMember(ctx, projectId, member.id, 'member');
    const taskId = await makeTask(ctx, projectId, lead.id);
    const memberCookie = await authCookie(ctx, member.id);
    const leadCookie = await authCookie(ctx, lead.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(memberCookie),
      payload: { body: '会被驳回的想法' },
    });
    const ideaId = (created.json() as IdeasResponse).ideas[0]?.id;

    const rejectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/reject`,
      headers: headers(leadCookie),
    });
    expect(rejectRes.statusCode).toBe(200);
    const rejected = (rejectRes.json() as IdeaResponse).idea;
    expect(rejected.status).toBe('rejected');
    expect(rejected.rewardPoints).toBeNull();
  });

  it('lists ideas across visible projects with context + a status filter', async () => {
    const admin = await makeUser(ctx, { role: 'admin' });
    const author = await makeUser(ctx);
    const projectId = await makeProject(ctx, admin.id);
    await addMember(ctx, projectId, author.id, 'member');
    const taskId = await makeTask(ctx, projectId, author.id);
    const authorCookie = await authCookie(ctx, author.id);
    const adminCookie = await authCookie(ctx, admin.id);

    const a = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(authorCookie),
      payload: { body: '想法A' },
    });
    const b = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(authorCookie),
      payload: { body: '想法B' },
    });
    const ideaAId = (a.json() as IdeasResponse).ideas[0]?.id;
    void b;

    // Adopt A so we can filter on status=adopted.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaAId}/adopt`,
      headers: headers(adminCookie),
      payload: { rewardPoints: 3 },
    });

    // Author sees both via the 灵感区, each carrying task/project context.
    const all = await ctx.app.inject({
      method: 'GET',
      url: '/api/ideas',
      headers: headers(authorCookie),
    });
    expect(all.statusCode).toBe(200);
    const allBody = all.json() as IdeasWithContextResponse;
    expect(allBody.ideas).toHaveLength(2);
    expect(allBody.ideas[0]?.taskTitle).toBeDefined();
    expect(allBody.ideas[0]?.projectId).toBe(projectId);
    expect(allBody.ideas[0]?.projectName).toBeDefined();

    // status=adopted narrows to just A.
    const adoptedOnly = await ctx.app.inject({
      method: 'GET',
      url: '/api/ideas?status=adopted',
      headers: headers(authorCookie),
    });
    const adoptedBody = adoptedOnly.json() as IdeasWithContextResponse;
    expect(adoptedBody.ideas).toHaveLength(1);
    expect(adoptedBody.ideas[0]?.body).toBe('想法A');
  });

  it('hides ideas in projects the (non-admin) caller cannot see', async () => {
    const admin = await makeUser(ctx, { role: 'admin' });
    const author = await makeUser(ctx);
    const outsider = await makeUser(ctx);
    const projectId = await makeProject(ctx, admin.id);
    await addMember(ctx, projectId, author.id, 'member');
    const taskId = await makeTask(ctx, projectId, author.id);
    const authorCookie = await authCookie(ctx, author.id);
    const outsiderCookie = await authCookie(ctx, outsider.id);

    await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(authorCookie),
      payload: { body: '私密想法' },
    });

    const outsiderRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/ideas',
      headers: headers(outsiderCookie),
    });
    expect(outsiderRes.statusCode).toBe(200);
    expect((outsiderRes.json() as IdeasWithContextResponse).ideas).toHaveLength(0);
  });

  it('credits adopted reward points to the author in the leaderboard + me stats', async () => {
    const lead = await makeUser(ctx, { displayName: 'Lead' });
    const author = await makeUser(ctx, { displayName: 'Author' });
    const projectId = await makeProject(ctx, lead.id);
    await addMember(ctx, projectId, lead.id, 'lead');
    await addMember(ctx, projectId, author.id, 'member');
    const taskId = await makeTask(ctx, projectId, author.id);
    const authorCookie = await authCookie(ctx, author.id);
    const leadCookie = await authCookie(ctx, lead.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: `/api/tasks/${taskId}/ideas`,
      headers: headers(authorCookie),
      payload: { body: '会被奖励的想法' },
    });
    const ideaId = (created.json() as IdeasResponse).ideas[0]?.id;

    await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(leadCookie),
      payload: { rewardPoints: 15 },
    });

    // Leaderboard: the author earns 15 reward points (completedCount stays 0).
    const lb = await ctx.app.inject({
      method: 'GET',
      url: `/api/stats/leaderboard?projectId=${projectId}&sort=points`,
      headers: headers(leadCookie),
    });
    expect(lb.statusCode).toBe(200);
    const entries = (lb.json() as LeaderboardResponse).entries;
    const authorEntry = entries.find((e) => e.user.displayName === 'Author');
    expect(authorEntry).toBeDefined();
    expect(authorEntry).toMatchObject({
      completedCount: 0,
      taskPoints: 0,
      rewardPoints: 15,
      pointsSum: 15,
    });

    // Me stats: same breakdown for the author.
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/stats/me',
      headers: headers(authorCookie),
    });
    expect((me.json() as MyStatsResponse)).toMatchObject({
      completedCount: 0,
      taskPoints: 0,
      rewardPoints: 15,
      pointsSum: 15,
    });

    // A rejected idea must NOT be credited.
    await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/reject`,
      headers: headers(leadCookie),
    });
    const meAfter = await ctx.app.inject({
      method: 'GET',
      url: '/api/stats/me',
      headers: headers(authorCookie),
    });
    expect((meAfter.json() as MyStatsResponse).rewardPoints).toBe(0);
  });

  it('requires authentication for the 灵感区 listing', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/ideas' });
    expect(res.statusCode).toBe(401);
  });

  // --- Standalone (灵感区) ideas -------------------------------------------

  it('posts a STANDALONE idea (POST /ideas) visible to another user with null context', async () => {
    const author = await makeUser(ctx);
    const other = await makeUser(ctx);
    const authorCookie = await authCookie(ctx, author.id);
    const otherCookie = await authCookie(ctx, other.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      headers: headers(authorCookie),
      payload: { body: '一个独立灵感' },
    });
    expect(created.statusCode).toBe(201);
    const createdIdea = (created.json() as IdeaResponse).idea;
    expect(createdIdea.taskId).toBeNull();
    expect(createdIdea.status).toBe('pending');
    expect(createdIdea.author.id).toBe(author.id);

    // Another logged-in user (in no projects) sees it with null task/project context.
    const listRes = await ctx.app.inject({
      method: 'GET',
      url: '/api/ideas',
      headers: headers(otherCookie),
    });
    expect(listRes.statusCode).toBe(200);
    const listed = (listRes.json() as IdeasWithContextResponse).ideas;
    const standalone = listed.find((i) => i.id === createdIdea.id);
    expect(standalone).toBeDefined();
    expect(standalone?.taskId).toBeNull();
    expect(standalone?.taskTitle).toBeNull();
    expect(standalone?.projectId).toBeNull();
    expect(standalone?.projectName).toBeNull();
    expect(standalone?.body).toBe('一个独立灵感');
  });

  it('rejects an empty STANDALONE idea body with 400', async () => {
    const author = await makeUser(ctx);
    const cookie = await authCookie(ctx, author.id);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      headers: headers(cookie),
      payload: { body: '   ' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires authentication to post a STANDALONE idea (401)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      // The CSRF header is present (so the request reaches auth), but no session.
      headers: { 'x-requested-with': 'fetch' },
      payload: { body: '匿名想法' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lets a global admin adopt a STANDALONE idea and credits the author', async () => {
    const admin = await makeUser(ctx, { role: 'admin' });
    const author = await makeUser(ctx, { displayName: 'StandaloneAuthor' });
    const authorCookie = await authCookie(ctx, author.id);
    const adminCookie = await authCookie(ctx, admin.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      headers: headers(authorCookie),
      payload: { body: '值得奖励的独立灵感' },
    });
    const ideaId = (created.json() as IdeaResponse).idea.id;

    const adoptRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(adminCookie),
      payload: { rewardPoints: 9 },
    });
    expect(adoptRes.statusCode).toBe(200);
    const adopted = (adoptRes.json() as IdeaResponse).idea;
    expect(adopted.status).toBe('adopted');
    expect(adopted.rewardPoints).toBe(9);
    expect(adopted.adoptedBy).toBe(admin.id);

    // The standalone reward credits the author in the no-filter leaderboard.
    const lb = await ctx.app.inject({
      method: 'GET',
      url: '/api/stats/leaderboard?sort=points',
      headers: headers(adminCookie),
    });
    const entries = (lb.json() as LeaderboardResponse).entries;
    const authorEntry = entries.find((e) => e.user.displayName === 'StandaloneAuthor');
    expect(authorEntry).toMatchObject({
      completedCount: 0,
      taskPoints: 0,
      rewardPoints: 9,
      pointsSum: 9,
    });

    // And in the author's own /stats/me (own contribution regardless of project).
    const me = await ctx.app.inject({
      method: 'GET',
      url: '/api/stats/me',
      headers: headers(authorCookie),
    });
    expect((me.json() as MyStatsResponse)).toMatchObject({
      rewardPoints: 9,
      pointsSum: 9,
    });
  });

  it('forbids a non-admin from adopting a STANDALONE idea (403)', async () => {
    const author = await makeUser(ctx);
    const other = await makeUser(ctx);
    const authorCookie = await authCookie(ctx, author.id);
    const otherCookie = await authCookie(ctx, other.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      headers: headers(authorCookie),
      payload: { body: '不该被普通用户采纳' },
    });
    const ideaId = (created.json() as IdeaResponse).idea.id;

    const adoptRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(otherCookie),
      payload: { rewardPoints: 5 },
    });
    expect(adoptRes.statusCode).toBe(403);

    // Even the author themselves cannot adopt their own standalone idea.
    const selfAdopt = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/adopt`,
      headers: headers(authorCookie),
      payload: { rewardPoints: 5 },
    });
    expect(selfAdopt.statusCode).toBe(403);

    const rows = await ctx.db.select().from(ideas).where(eq(ideas.id, ideaId));
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.rewardPoints).toBeNull();
  });

  it('lets a global admin reject a STANDALONE idea but forbids a non-admin (403)', async () => {
    const admin = await makeUser(ctx, { role: 'admin' });
    const author = await makeUser(ctx);
    const other = await makeUser(ctx);
    const authorCookie = await authCookie(ctx, author.id);
    const adminCookie = await authCookie(ctx, admin.id);
    const otherCookie = await authCookie(ctx, other.id);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/ideas',
      headers: headers(authorCookie),
      payload: { body: '会被驳回的独立灵感' },
    });
    const ideaId = (created.json() as IdeaResponse).idea.id;

    const nonAdminReject = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/reject`,
      headers: headers(otherCookie),
    });
    expect(nonAdminReject.statusCode).toBe(403);

    const rejectRes = await ctx.app.inject({
      method: 'POST',
      url: `/api/ideas/${ideaId}/reject`,
      headers: headers(adminCookie),
    });
    expect(rejectRes.statusCode).toBe(200);
    expect((rejectRes.json() as IdeaResponse).idea.status).toBe('rejected');
  });
});
