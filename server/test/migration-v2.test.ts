import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Migration test for lifecycle v2 (§2, §6). Verifies the 0003 migration:
 * - adds the new `task_status` enum value `pending_review` (usable post-migration),
 * - adds the new `activity_type` values `delivered` / `rejected`,
 * - creates the `task_claimants` table,
 * - performs the data copy (deprecated `assignee_id` / `completed_by` →
 *   `task_claimants`) with the correct per-claimant points logic.
 *
 * It replays the generated SQL up to 0002, seeds legacy single-assignee task rows,
 * then applies 0003 and asserts the resulting claimant rows.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(here, '../drizzle');

interface MigrationJournal {
  entries: { idx: number; tag: string }[];
}

/** Read the ordered migration tags from the drizzle journal. */
async function orderedTags(): Promise<string[]> {
  const journalPath = join(MIGRATIONS_FOLDER, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as MigrationJournal;
  return [...journal.entries].sort((a, b) => a.idx - b.idx).map((e) => e.tag);
}

/** Apply a single migration file (split on the drizzle statement-breakpoint). */
async function applyMigration(pglite: PGlite, tag: string): Promise<void> {
  const raw = await readFile(join(MIGRATIONS_FOLDER, `${tag}.sql`), 'utf8');
  const statements = raw
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await pglite.exec(statement);
  }
}

let pglite: PGlite | undefined;

afterEach(async () => {
  if (pglite) {
    await pglite.close();
    pglite = undefined;
  }
});

describe('0003_task_lifecycle_v2 migration', () => {
  it('adds the enum value + task_claimants and copies legacy assignees', async () => {
    pglite = new PGlite();
    const tags = await orderedTags();
    const v2Tag = '0003_task_lifecycle_v2';
    const v2Index = tags.indexOf(v2Tag);
    expect(v2Index).toBeGreaterThan(0);

    // 1) Apply everything up to (but excluding) the v2 migration — the v1 schema.
    for (const tag of tags.slice(0, v2Index)) {
      await applyMigration(pglite, tag);
    }

    // 2) Seed legacy data using the v1 single-assignee shape.
    await pglite.exec(`
      INSERT INTO users (id, email, password_hash, display_name, avatar_color)
      VALUES
        ('11111111-1111-1111-1111-111111111111', 'a@x.com', 'h', 'Alice', '#3b82f6'),
        ('22222222-2222-2222-2222-222222222222', 'b@x.com', 'h', 'Bob',   '#ef4444');
      INSERT INTO projects (id, name, key, created_by)
      VALUES ('33333333-3333-3333-3333-333333333333', 'P', 'P1',
              '11111111-1111-1111-1111-111111111111');
    `);
    // Task 1: in_progress, assigned to Alice (not done) → claimant with NULL points.
    // Task 2: done, assignee=Alice, completed_by=Bob → two claimants; the done
    //         points (5) are copied onto both legacy rows.
    await pglite.exec(`
      INSERT INTO tasks (id, project_id, title, status, assignee_id, points,
                         created_by, rank, completed_at, completed_by, created_at)
      VALUES
        ('44444444-4444-4444-4444-444444444444',
         '33333333-3333-3333-3333-333333333333', 'T1', 'in_progress',
         '11111111-1111-1111-1111-111111111111', NULL,
         '11111111-1111-1111-1111-111111111111', 'a', NULL, NULL, now()),
        ('55555555-5555-5555-5555-555555555555',
         '33333333-3333-3333-3333-333333333333', 'T2', 'done',
         '11111111-1111-1111-1111-111111111111', 5,
         '11111111-1111-1111-1111-111111111111', 'b', now(),
         '22222222-2222-2222-2222-222222222222', now());
    `);

    // Pre-condition: task_claimants does not exist yet.
    const preCheck = await pglite.query<{ exists: boolean }>(
      `SELECT to_regclass('public.task_claimants') IS NOT NULL AS exists;`,
    );
    expect(preCheck.rows[0]?.exists).toBe(false);

    // 3) Apply the v2 migration.
    await applyMigration(pglite, v2Tag);

    // 4a) The new enum value is usable.
    const enumRows = await pglite.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::task_status))::text AS value;`,
    );
    expect(enumRows.rows.map((r) => r.value)).toContain('pending_review');

    const activityEnum = await pglite.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::activity_type))::text AS value;`,
    );
    const activityValues = activityEnum.rows.map((r) => r.value);
    expect(activityValues).toContain('delivered');
    expect(activityValues).toContain('rejected');

    // It can actually be written to a row.
    await pglite.exec(
      `UPDATE tasks SET status = 'pending_review'
       WHERE id = '44444444-4444-4444-4444-444444444444';`,
    );
    const updated = await pglite.query<{ status: string }>(
      `SELECT status FROM tasks WHERE id = '44444444-4444-4444-4444-444444444444';`,
    );
    expect(updated.rows[0]?.status).toBe('pending_review');

    // 4b) The data copy populated task_claimants.
    const claimants = await pglite.query<{
      task_id: string;
      user_id: string;
      points: number | null;
    }>(
      `SELECT task_id, user_id, points FROM task_claimants ORDER BY task_id, user_id;`,
    );
    const rows = claimants.rows.map((r) => ({
      taskId: r.task_id,
      userId: r.user_id,
      points: r.points,
    }));

    // T1: one claimant (Alice), NULL points (task not done).
    const t1 = rows.filter((r) => r.taskId === '44444444-4444-4444-4444-444444444444');
    expect(t1).toEqual([
      {
        taskId: '44444444-4444-4444-4444-444444444444',
        userId: '11111111-1111-1111-1111-111111111111',
        points: null,
      },
    ]);

    // T2: two claimants (assignee Alice + divergent completed_by Bob), each with
    // the done task's points (5).
    const t2 = rows
      .filter((r) => r.taskId === '55555555-5555-5555-5555-555555555555')
      .sort((a, b) => a.userId.localeCompare(b.userId));
    expect(t2).toEqual([
      {
        taskId: '55555555-5555-5555-5555-555555555555',
        userId: '11111111-1111-1111-1111-111111111111',
        points: 5,
      },
      {
        taskId: '55555555-5555-5555-5555-555555555555',
        userId: '22222222-2222-2222-2222-222222222222',
        points: 5,
      },
    ]);
  });
});
