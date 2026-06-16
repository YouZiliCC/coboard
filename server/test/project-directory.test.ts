import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth/session.js';
import { projectMembers, projects, sessions, users } from '../src/db/schema.js';
import type { TestContext } from './helpers.js';
import { createTestContext } from './helpers.js';

/**
 * Project directory + self-service join/leave (§6.3, §7). Covers: the directory
 * lists every non-archived project with correct isMember/memberCount; join adds a
 * `member` row, is idempotent, and never downgrades an existing lead; leave removes
 * the caller's row; the sole-lead leave is refused with 409; archived projects are
 * excluded. Auth uses signed session cookies + the CSRF header on unsafe methods.
 */

interface SeededUser {
  id: string;
  cookie: string;
}

async function seedUser(
  ctx: TestContext,
  opts: { role?: 'admin' | 'member' } = {},
): Promise<SeededUser> {
  const [user] = await ctx.db
    .insert(users)
    .values({
      email: `${randomUUID()}@example.com`,
      passwordHash: 'x',
      displayName: 'Tester',
      avatarColor: '#3b82f6',
      role: opts.role ?? 'member',
    })
    .returning();
  if (!user) throw new Error('seedUser: insert returned no row');

  const token = randomUUID();
  await ctx.db.insert(sessions).values({
    id: token,
    userId: user.id,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    lastSeenAt: new Date(),
  });

  const signed = ctx.app.signCookie(token);
  return { id: user.id, cookie: `${SESSION_COOKIE}=${signed}` };
}

function authHeaders(user: SeededUser): Record<string, string> {
  return {
    cookie: user.cookie,
    'x-requested-with': 'fetch',
  };
}

function json<T>(res: LightMyRequestResponse): T {
  return res.json() as T;
}

function errorCode(res: LightMyRequestResponse): string | undefined {
  const body = res.json() as {
    error?: { code?: string } | string;
    code?: string;
  };
  if (body.error && typeof body.error === 'object') return body.error.code;
  return body.code;
}

/** Insert a project owned by `createdBy` and return its id. */
async function seedProject(
  ctx: TestContext,
  createdBy: string,
  opts: { key?: string; name?: string; archived?: boolean } = {},
): Promise<string> {
  const [project] = await ctx.db
    .insert(projects)
    .values({
      name: opts.name ?? 'Proj',
      key: opts.key ?? `K${randomUUID().slice(0, 6).toUpperCase()}`,
      archived: opts.archived ?? false,
      createdBy,
    })
    .returning();
  if (!project) throw new Error('seedProject: insert returned no row');
  return project.id;
}

interface DirectoryItem {
  id: string;
  isMember: boolean;
  memberCount: number;
  archived: boolean;
}

describe('project directory + self-service join/leave', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  beforeEach(async () => {
    await ctx.db.delete(projectMembers);
    await ctx.db.delete(projects);
  });

  describe('GET /api/projects/directory', () => {
    it('lists non-archived projects with isMember + memberCount; excludes archived', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });

      // alpha: me is a member (admin lead + me = 2 members).
      const alpha = await seedProject(ctx, admin.id, { name: 'Alpha', key: 'ALPHA' });
      await ctx.db.insert(projectMembers).values([
        { projectId: alpha, userId: admin.id, role: 'lead' },
        { projectId: alpha, userId: me.id, role: 'member' },
      ]);

      // beta: me is NOT a member (just the admin lead = 1 member).
      const beta = await seedProject(ctx, admin.id, { name: 'Beta', key: 'BETA' });
      await ctx.db
        .insert(projectMembers)
        .values({ projectId: beta, userId: admin.id, role: 'lead' });

      // gamma: archived — must not appear.
      await seedProject(ctx, admin.id, {
        name: 'Gamma',
        key: 'GAMMA',
        archived: true,
      });

      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/projects/directory',
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(200);
      const list = json<{ projects: DirectoryItem[] }>(res).projects;

      // Only alpha + beta (gamma archived).
      expect(list.map((p) => p.id).sort()).toEqual([alpha, beta].sort());
      expect(list.some((p) => p.archived)).toBe(false);

      const alphaItem = list.find((p) => p.id === alpha)!;
      const betaItem = list.find((p) => p.id === beta)!;
      expect(alphaItem.isMember).toBe(true);
      expect(alphaItem.memberCount).toBe(2);
      expect(betaItem.isMember).toBe(false);
      expect(betaItem.memberCount).toBe(1);
    });

    it('rejects unauthenticated access with 401', async () => {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/projects/directory',
        headers: { 'x-requested-with': 'fetch' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/projects/:id/join', () => {
    it('adds a member membership for the caller', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, admin.id, { key: 'JOIN' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/join`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(200);

      const rows = await ctx.db.select().from(projectMembers);
      const mine = rows.find((r) => r.userId === me.id);
      expect(mine).toBeDefined();
      expect(mine?.role).toBe('member');
    });

    it('is idempotent and does NOT downgrade an existing lead', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, admin.id, { key: 'IDEM' });
      // me is already a lead.
      await ctx.db
        .insert(projectMembers)
        .values({ projectId, userId: me.id, role: 'lead' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/join`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(200);

      const rows = await ctx.db
        .select()
        .from(projectMembers)
        .where(eqUserProject(projectId, me.id));
      expect(rows).toHaveLength(1);
      // Role preserved — never downgraded to member.
      expect(rows[0]?.role).toBe('lead');
    });

    it('returns 404 for an archived project', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, admin.id, {
        key: 'ARCH',
        archived: true,
      });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/join`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/projects/:id/leave', () => {
    it('removes the caller membership', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, admin.id, { key: 'LEAVE' });
      await ctx.db.insert(projectMembers).values([
        { projectId, userId: admin.id, role: 'lead' },
        { projectId, userId: me.id, role: 'member' },
      ]);

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/leave`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(200);

      const rows = await ctx.db.select().from(projectMembers);
      expect(rows.some((r) => r.userId === me.id)).toBe(false);
    });

    it('returns 404 when the caller is not a member', async () => {
      const admin = await seedUser(ctx, { role: 'admin' });
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, admin.id, { key: 'NOTMEM' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/leave`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(404);
    });

    it('refuses with 409 when the caller is the sole remaining lead', async () => {
      const me = await seedUser(ctx, { role: 'member' });
      const projectId = await seedProject(ctx, me.id, { key: 'SOLELEAD' });
      // me is the only lead (and only member).
      await ctx.db
        .insert(projectMembers)
        .values({ projectId, userId: me.id, role: 'lead' });

      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/leave`,
        headers: authHeaders(me),
      });
      expect(res.statusCode).toBe(409);
      expect(errorCode(res)).toBe('conflict');

      // Still a member — leave was refused.
      const rows = await ctx.db.select().from(projectMembers);
      expect(rows.some((r) => r.userId === me.id)).toBe(true);
    });
  });
});

/** Local helper: project_members row for (projectId, userId). */
function eqUserProject(projectId: string, userId: string) {
  return and(
    eq(projectMembers.projectId, projectId),
    eq(projectMembers.userId, userId),
  );
}
