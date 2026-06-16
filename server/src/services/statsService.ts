import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type {
  LeaderboardEntry,
  MyStatsResponse,
  StatsSort,
  TrendBucket,
  TrendPoint,
  User,
} from 'shared';
import type { Database } from '../db/index.js';
import {
  projectMembers,
  taskClaimants,
  tasks,
  users,
  type UserRow,
} from '../db/schema.js';

/**
 * Contribution-statistics service (§6.4 / §7; lifecycle v2 §4). Metrics are
 * computed live by joining `task_claimants` to `tasks WHERE status='done'` — there
 * is no pre-aggregation table. Each claimant earns +1 completed and their locked
 * points share (claimant.points, NULL→0). The time window filters on the task's
 * `completed_at` (locked at approval; attribution is therefore stable).
 *
 * Metric definitions (§4):
 * - count  = number of done tasks the user claimed (each counts as exactly 1).
 * - points = SUM(task_claimants.points) treating a NULL share as 0.
 *
 * Routes call these after the auth/membership guards have run; the service itself
 * only encodes the visibility scope it is handed (a concrete project id or the set
 * of project ids the caller may see).
 */

// ---------------------------------------------------------------------------
// Row → wire serialization (kept local so this module is self-contained)
// ---------------------------------------------------------------------------

/** Serialize a user row into the public §5 wire shape (drops password_hash). */
function serializeUser(row: UserRow): User {
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

// ---------------------------------------------------------------------------
// Visibility scope
// ---------------------------------------------------------------------------

/**
 * Describes which projects a stats query may aggregate over.
 * - `{ kind: 'project', projectId }`  — a single, already-authorized project.
 * - `{ kind: 'all' }`                 — every project (global admin).
 * - `{ kind: 'projects', projectIds }`— the explicit set the caller belongs to.
 */
export type StatsScope =
  | { kind: 'project'; projectId: string }
  | { kind: 'all' }
  | { kind: 'projects'; projectIds: string[] };

/**
 * Resolve the set of project ids a (non-project-scoped) leaderboard query should
 * cover for `user`: every project for a global admin, otherwise the projects the
 * user is a member of. Returned as a `StatsScope` ready to feed the aggregates.
 */
export async function resolveVisibleScope(
  db: Database,
  user: UserRow,
): Promise<StatsScope> {
  if (user.role === 'admin') {
    return { kind: 'all' };
  }
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, user.id));
  return { kind: 'projects', projectIds: rows.map((r) => r.projectId) };
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

/**
 * Build the WHERE predicate shared by every contribution aggregate (lifecycle v2
 * §4): only `done` tasks, narrowed by the time window and the visibility scope, and
 * optionally to a single claimant. Designed for a query that joins `task_claimants`
 * to `tasks`. Returns `'never'` when the scope can never match (empty project set)
 * so callers can short-circuit to an empty result.
 */
function buildBaseFilters(args: {
  scope: StatsScope;
  from?: Date;
  to?: Date;
  userId?: string;
}): ReturnType<typeof and> | undefined | 'never' {
  const conditions = [eq(tasks.status, 'done')];

  switch (args.scope.kind) {
    case 'project':
      conditions.push(eq(tasks.projectId, args.scope.projectId));
      break;
    case 'projects':
      if (args.scope.projectIds.length === 0) return 'never';
      conditions.push(inArray(tasks.projectId, args.scope.projectIds));
      break;
    case 'all':
      break;
  }

  if (args.userId) {
    conditions.push(eq(taskClaimants.userId, args.userId));
  }
  if (args.from) {
    conditions.push(gte(tasks.completedAt, args.from));
  }
  if (args.to) {
    conditions.push(lte(tasks.completedAt, args.to));
  }

  return and(...conditions);
}

/** SUM(claimant points share) with NULL treated as 0, as a JS integer (§4). */
const pointsSumSql = sql<number>`coalesce(sum(coalesce(${taskClaimants.points}, 0)), 0)::int`;
/** COUNT(*) of (claimant, done task) rows — each claimant earns +1 (§4). */
const completedCountSql = sql<number>`count(*)::int`;

// ---------------------------------------------------------------------------
// Leaderboard (GET /stats/leaderboard)
// ---------------------------------------------------------------------------

export interface LeaderboardArgs {
  scope: StatsScope;
  from?: Date;
  to?: Date;
  sort: StatsSort;
}

/**
 * Per-user completed-count + points-sum, ranked. Attribution is by claimants of
 * done tasks (§4). Sorting: by the chosen metric descending, then the other metric
 * descending, then `display_name` ascending so the order is fully deterministic.
 */
export async function getLeaderboard(
  db: Database,
  args: LeaderboardArgs,
): Promise<LeaderboardEntry[]> {
  const where = buildBaseFilters({
    scope: args.scope,
    from: args.from,
    to: args.to,
  });
  if (where === 'never') return [];

  const rows = await db
    .select({
      user: users,
      completedCount: completedCountSql,
      pointsSum: pointsSumSql,
    })
    .from(taskClaimants)
    .innerJoin(tasks, eq(tasks.id, taskClaimants.taskId))
    .innerJoin(users, eq(users.id, taskClaimants.userId))
    .where(where)
    .groupBy(users.id);

  const entries: LeaderboardEntry[] = rows.map((row) => ({
    user: serializeUser(row.user),
    completedCount: row.completedCount,
    pointsSum: row.pointsSum,
  }));

  // Stable, fully-deterministic ordering (DB group order is unspecified).
  const primary = args.sort;
  entries.sort((a, b) => {
    if (primary === 'count') {
      if (b.completedCount !== a.completedCount) {
        return b.completedCount - a.completedCount;
      }
      if (b.pointsSum !== a.pointsSum) return b.pointsSum - a.pointsSum;
    } else {
      if (b.pointsSum !== a.pointsSum) return b.pointsSum - a.pointsSum;
      if (b.completedCount !== a.completedCount) {
        return b.completedCount - a.completedCount;
      }
    }
    return a.user.displayName.localeCompare(b.user.displayName);
  });

  return entries;
}

// ---------------------------------------------------------------------------
// My stats (GET /stats/me)
// ---------------------------------------------------------------------------

export interface MyStatsArgs {
  userId: string;
  from?: Date;
  to?: Date;
}

/**
 * The current user's completed count + points sum across every project (a user's
 * own contribution is attributed to them regardless of project membership scope).
 */
export async function getMyStats(
  db: Database,
  args: MyStatsArgs,
): Promise<MyStatsResponse> {
  const where = buildBaseFilters({
    scope: { kind: 'all' },
    from: args.from,
    to: args.to,
    userId: args.userId,
  });
  if (where === 'never') return { completedCount: 0, pointsSum: 0 };

  const rows = await db
    .select({
      completedCount: completedCountSql,
      pointsSum: pointsSumSql,
    })
    .from(taskClaimants)
    .innerJoin(tasks, eq(tasks.id, taskClaimants.taskId))
    .where(where);

  const row = rows[0];
  return {
    completedCount: row?.completedCount ?? 0,
    pointsSum: row?.pointsSum ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Trend (GET /stats/trend)
// ---------------------------------------------------------------------------

export interface TrendArgs {
  scope: StatsScope;
  userId: string;
  from?: Date;
  to?: Date;
  bucket: TrendBucket;
}

/**
 * Completed-per-bucket series for a single user, for charting. Buckets the
 * `completed_at` timestamp by day or ISO week and returns one ascending-ordered
 * point per non-empty bucket. The bucket label is the bucket-start date
 * ("YYYY-MM-DD"); empty buckets are omitted (the client fills gaps for display).
 */
export async function getTrend(
  db: Database,
  args: TrendArgs,
): Promise<TrendPoint[]> {
  const where = buildBaseFilters({
    scope: args.scope,
    from: args.from,
    to: args.to,
    userId: args.userId,
  });
  if (where === 'never') return [];

  // date_trunc → the bucket start; cast to ::date renders as "YYYY-MM-DD".
  // The unit is embedded as a SQL literal (not a bind parameter) so the GROUP BY
  // expression is byte-identical to the SELECT expression; it comes from a closed
  // enum, so there is no injection surface.
  const unit = args.bucket === 'week' ? 'week' : 'day';
  const bucketDate = sql<string>`date_trunc('${sql.raw(unit)}', ${tasks.completedAt})::date::text`;

  const rows = await db
    .select({
      date: bucketDate,
      completedCount: completedCountSql,
      pointsSum: pointsSumSql,
    })
    .from(taskClaimants)
    .innerJoin(tasks, eq(tasks.id, taskClaimants.taskId))
    .where(where)
    .groupBy(bucketDate)
    .orderBy(bucketDate);

  return rows.map((row) => ({
    date: row.date,
    completedCount: row.completedCount,
    pointsSum: row.pointsSum,
  }));
}
