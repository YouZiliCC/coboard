import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
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
  ideas,
  projectMembers,
  taskClaimants,
  tasks,
  users,
  type UserRow,
} from '../db/schema.js';

/**
 * Contribution-statistics service (§6.4 / §7; lifecycle v2 §4; §7.1 ideas). Metrics
 * are computed live (no pre-aggregation table).
 *
 * Points have TWO sources, summed into `pointsSum` and also surfaced split as
 * `taskPoints` + `rewardPoints` (§7.1):
 * - task share points: join `task_claimants` to `tasks WHERE status='done'`. Each
 *   claimant earns +1 completed and their locked share (claimant.points, NULL→0),
 *   time-filtered on the task's `completed_at`.
 * - idea reward points: SUM(`ideas.reward_points`) over ideas the user authored that
 *   were adopted (`status='adopted'`), time-filtered on the idea's `updated_at` (the
 *   adoption time) — consistent with how task points filter on `completed_at`. Ideas
 *   LEFT-join their task so STANDALONE adopted ideas (no task/project) still count for
 *   the "all" / own-visible scopes (a specific-project filter excludes them, §7.1).
 *
 * The completed COUNT stays tasks-only (§7.1: 完成数仍只来自任务).
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
 * Describes which tasks a stats query may aggregate over.
 * - `{ kind: 'project', projectId }`  — a single, already-authorized project; excludes
 *   no-project (pool) tasks (§8).
 * - `{ kind: 'all' }`                 — every project + the task pool (global admin).
 * - `{ kind: 'projects', projectIds }`— the caller's member projects PLUS the shared
 *   task pool (no-project tasks are visible to all, §8).
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
      // A specific project excludes no-project (pool) tasks (§8).
      conditions.push(eq(tasks.projectId, args.scope.projectId));
      break;
    case 'projects': {
      // The caller's visible scope: their member projects PLUS the shared task pool
      // (no-project tasks are visible to every user, so they count in "all", §8).
      const pool = isNull(tasks.projectId);
      const predicate =
        args.scope.projectIds.length === 0
          ? pool
          : or(pool, inArray(tasks.projectId, args.scope.projectIds));
      if (predicate) conditions.push(predicate);
      break;
    }
    case 'all':
      // Every project + the pool (no project filter).
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
/** SUM(adopted idea reward points) with NULL treated as 0, as a JS integer (§7.1). */
const rewardPointsSumSql = sql<number>`coalesce(sum(coalesce(${ideas.rewardPoints}, 0)), 0)::int`;

// ---------------------------------------------------------------------------
// Adopted-idea reward points (§7.1)
// ---------------------------------------------------------------------------

/**
 * Build the WHERE predicate for the adopted-idea reward aggregate (§7.1): only
 * `adopted` ideas, narrowed by the visibility scope (joined via the idea's task's
 * project) and the time window on the idea's `updated_at` (the adoption time), and
 * optionally to a single author. An empty member-project set still matches the
 * no-project ideas (standalone + pool), so this never returns `'never'`.
 */
function buildRewardFilters(args: {
  scope: StatsScope;
  from?: Date;
  to?: Date;
  userId?: string;
}): ReturnType<typeof and> | undefined | 'never' {
  const conditions = [eq(ideas.status, 'adopted')];

  switch (args.scope.kind) {
    case 'project':
      // A specific project excludes ideas on no-project (pool) tasks AND standalone
      // ideas (no task → NULL project via the LEFT JOIN) (§7.1 / §8).
      conditions.push(eq(tasks.projectId, args.scope.projectId));
      break;
    case 'projects': {
      // Member projects PLUS ideas with no project: pool-task ideas and STANDALONE
      // 灵感区 ideas (both visible to all logged-in users) (§7.1 / §8).
      const pool = isNull(tasks.projectId);
      const predicate =
        args.scope.projectIds.length === 0
          ? pool
          : or(pool, inArray(tasks.projectId, args.scope.projectIds));
      if (predicate) conditions.push(predicate);
      break;
    }
    case 'all':
      break;
  }

  if (args.userId) {
    conditions.push(eq(ideas.authorId, args.userId));
  }
  if (args.from) {
    conditions.push(gte(ideas.updatedAt, args.from));
  }
  if (args.to) {
    conditions.push(lte(ideas.updatedAt, args.to));
  }

  return and(...conditions);
}

/**
 * Per-author reward-points sum from adopted ideas, as a Map keyed by author id.
 * Authors with no adopted ideas in scope are simply absent (callers default to 0).
 */
async function rewardPointsByAuthor(
  db: Database,
  args: { scope: StatsScope; from?: Date; to?: Date },
): Promise<Map<string, number>> {
  const where = buildRewardFilters(args);
  if (where === 'never') return new Map();

  const rows = await db
    .select({ authorId: ideas.authorId, rewardPoints: rewardPointsSumSql })
    .from(ideas)
    .leftJoin(tasks, eq(tasks.id, ideas.taskId))
    .where(where)
    .groupBy(ideas.authorId);

  const byAuthor = new Map<string, number>();
  for (const row of rows) {
    byAuthor.set(row.authorId, row.rewardPoints);
  }
  return byAuthor;
}

/** Single-user reward-points sum from adopted ideas (§7.1). */
async function rewardPointsForUser(
  db: Database,
  args: { scope: StatsScope; from?: Date; to?: Date; userId: string },
): Promise<number> {
  const where = buildRewardFilters(args);
  if (where === 'never') return 0;

  const rows = await db
    .select({ rewardPoints: rewardPointsSumSql })
    .from(ideas)
    .leftJoin(tasks, eq(tasks.id, ideas.taskId))
    .where(where);
  return rows[0]?.rewardPoints ?? 0;
}

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
  // An empty visible-project set means no contributions can match either source.
  if (where === 'never') return [];

  const taskRows = await db
    .select({
      user: users,
      completedCount: completedCountSql,
      taskPoints: pointsSumSql,
    })
    .from(taskClaimants)
    .innerJoin(tasks, eq(tasks.id, taskClaimants.taskId))
    .innerJoin(users, eq(users.id, taskClaimants.userId))
    .where(where)
    .groupBy(users.id);

  // Adopted-idea reward points (§7.1) — folded into pointsSum, also surfaced split.
  const rewardByAuthor = await rewardPointsByAuthor(db, {
    scope: args.scope,
    from: args.from,
    to: args.to,
  });

  // Build entries keyed by user id, starting from task contributors.
  const byUser = new Map<string, LeaderboardEntry>();
  for (const row of taskRows) {
    byUser.set(row.user.id, {
      user: serializeUser(row.user),
      completedCount: row.completedCount,
      taskPoints: row.taskPoints,
      rewardPoints: 0,
      pointsSum: row.taskPoints,
    });
  }

  // Merge in reward points — a user may have rewards but no completed tasks, in
  // which case they appear with completedCount 0 (counts stay tasks-only, §7.1).
  const rewardOnlyUserIds = [...rewardByAuthor.keys()].filter((id) => !byUser.has(id));
  if (rewardOnlyUserIds.length > 0) {
    const extra = await db
      .select()
      .from(users)
      .where(inArray(users.id, rewardOnlyUserIds));
    for (const u of extra) {
      byUser.set(u.id, {
        user: serializeUser(u),
        completedCount: 0,
        taskPoints: 0,
        rewardPoints: 0,
        pointsSum: 0,
      });
    }
  }
  for (const [authorId, reward] of rewardByAuthor) {
    const entry = byUser.get(authorId);
    if (entry) {
      entry.rewardPoints = reward;
      entry.pointsSum = entry.taskPoints + reward;
    }
  }

  const entries = [...byUser.values()];

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
  const scope: StatsScope = { kind: 'all' };
  const where = buildBaseFilters({
    scope,
    from: args.from,
    to: args.to,
    userId: args.userId,
  });

  const rows =
    where === 'never'
      ? []
      : await db
          .select({
            completedCount: completedCountSql,
            taskPoints: pointsSumSql,
          })
          .from(taskClaimants)
          .innerJoin(tasks, eq(tasks.id, taskClaimants.taskId))
          .where(where);

  const row = rows[0];
  const completedCount = row?.completedCount ?? 0;
  const taskPoints = row?.taskPoints ?? 0;

  // Adopted-idea reward points authored by the caller (§7.1), across all projects.
  const rewardPoints = await rewardPointsForUser(db, {
    scope,
    from: args.from,
    to: args.to,
    userId: args.userId,
  });

  return {
    completedCount,
    taskPoints,
    rewardPoints,
    pointsSum: taskPoints + rewardPoints,
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
 *
 * `pointsSum` per bucket folds in adopted-idea reward points (§7.1), bucketed by the
 * idea's `updated_at` (adoption time); the completed count stays tasks-only. A bucket
 * with only reward points (no completed task) still appears, with completedCount 0.
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

  // date_trunc → the bucket start; cast to ::date renders as "YYYY-MM-DD".
  // The unit is embedded as a SQL literal (not a bind parameter) so the GROUP BY
  // expression is byte-identical to the SELECT expression; it comes from a closed
  // enum, so there is no injection surface.
  const unit = args.bucket === 'week' ? 'week' : 'day';
  const bucketDate = sql<string>`date_trunc('${sql.raw(unit)}', ${tasks.completedAt})::date::text`;

  const taskRows =
    where === 'never'
      ? []
      : await db
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

  // Per-bucket adopted-idea reward points for this user (§7.1).
  const rewardWhere = buildRewardFilters({
    scope: args.scope,
    from: args.from,
    to: args.to,
    userId: args.userId,
  });
  const rewardBucketDate = sql<string>`date_trunc('${sql.raw(unit)}', ${ideas.updatedAt})::date::text`;
  const rewardRows =
    rewardWhere === 'never'
      ? []
      : await db
          .select({ date: rewardBucketDate, rewardPoints: rewardPointsSumSql })
          .from(ideas)
          .leftJoin(tasks, eq(tasks.id, ideas.taskId))
          .where(rewardWhere)
          .groupBy(rewardBucketDate);

  // Merge the two bucketed series, summing reward points into the bucket pointsSum.
  const byDate = new Map<string, TrendPoint>();
  for (const row of taskRows) {
    byDate.set(row.date, {
      date: row.date,
      completedCount: row.completedCount,
      pointsSum: row.pointsSum,
    });
  }
  for (const row of rewardRows) {
    const point = byDate.get(row.date);
    if (point) {
      point.pointsSum += row.rewardPoints;
    } else {
      byDate.set(row.date, {
        date: row.date,
        completedCount: 0,
        pointsSum: row.rewardPoints,
      });
    }
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
