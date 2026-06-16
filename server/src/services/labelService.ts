import { asc, eq, inArray } from 'drizzle-orm';
import type { CreateLabelInput, Label, UpdateLabelInput } from 'shared';
import type { Database } from '../db/index.js';
import { labels, taskLabels, type LabelRow } from '../db/schema.js';
import { conflict, notFound, validationError } from '../lib/errors.js';

/**
 * Label catalog domain service (task-labels feature). Owns the GLOBAL label catalog
 * (one shared set of `{ name, color }` across every project/task) and the
 * many-to-many `task_labels` join. Any logged-in user may create a label (the route
 * layer enforces auth); rename/recolor/delete are global-admin-only (enforced by the
 * route). `setTaskLabels` is the REPLACE helper used by task create/patch to make a
 * task's labels exactly a given id set.
 */

/** Serialize a label row to the shared `Label` wire shape. */
function serializeLabel(row: LabelRow): Label {
  return { id: row.id, name: row.name, color: row.color };
}

/** List the whole catalog, ordered by name for a stable picker. */
export async function listLabels(db: Database): Promise<Label[]> {
  const rows = await db.select().from(labels).orderBy(asc(labels.name));
  return rows.map(serializeLabel);
}

/**
 * Load the labels for a set of task ids in one query (no N+1). Returns a map of
 * taskId -> labels, each task's labels ordered by name to match the catalog.
 */
export async function loadLabelsForTasks(
  db: Database,
  taskIds: string[],
): Promise<Map<string, Label[]>> {
  const byTask = new Map<string, Label[]>();
  if (taskIds.length === 0) return byTask;
  const rows = await db
    .select({
      taskId: taskLabels.taskId,
      id: labels.id,
      name: labels.name,
      color: labels.color,
    })
    .from(taskLabels)
    .innerJoin(labels, eq(labels.id, taskLabels.labelId))
    .where(inArray(taskLabels.taskId, taskIds))
    .orderBy(asc(labels.name));
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push({ id: r.id, name: r.name, color: r.color });
    byTask.set(r.taskId, list);
  }
  return byTask;
}

/**
 * Create a catalog label. The name is unique across the shared catalog, so a
 * duplicate (case-sensitive, as stored) throws 409.
 */
export async function createLabel(
  db: Database,
  createdBy: string,
  input: CreateLabelInput,
): Promise<Label> {
  const existing = await db
    .select({ id: labels.id })
    .from(labels)
    .where(eq(labels.name, input.name))
    .limit(1);
  if (existing.length > 0) {
    throw conflict('已存在同名标签');
  }
  const [created] = await db
    .insert(labels)
    .values({ name: input.name, color: input.color, createdBy })
    .returning();
  if (!created) {
    throw new Error('创建标签失败：未返回插入行');
  }
  return serializeLabel(created);
}

/** Rename / recolor a label (global admin only — enforced by the route). */
export async function updateLabel(
  db: Database,
  labelId: string,
  input: UpdateLabelInput,
): Promise<Label> {
  // A rename to another label's name would violate the unique catalog name.
  if (input.name !== undefined) {
    const clash = await db
      .select({ id: labels.id })
      .from(labels)
      .where(eq(labels.name, input.name))
      .limit(1);
    if (clash[0] && clash[0].id !== labelId) {
      throw conflict('已存在同名标签');
    }
  }
  const patch: Partial<LabelRow> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.color !== undefined) patch.color = input.color;
  const [updated] = await db
    .update(labels)
    .set(patch)
    .where(eq(labels.id, labelId))
    .returning();
  if (!updated) {
    throw notFound('标签不存在');
  }
  return serializeLabel(updated);
}

/** Delete a label; cascades it off every task it was applied to. */
export async function deleteLabel(db: Database, labelId: string): Promise<void> {
  const removed = await db
    .delete(labels)
    .where(eq(labels.id, labelId))
    .returning({ id: labels.id });
  if (removed.length === 0) {
    throw notFound('标签不存在');
  }
}

/**
 * REPLACE a task's labels with exactly `labelIds` (task-labels feature). Used by task
 * create/patch. Validates every id exists in the catalog (400 otherwise), then
 * rewrites the join rows: deletes the current set and inserts the new one. An empty
 * array clears the task's labels. Idempotent w.r.t. duplicate ids in the input.
 */
export async function setTaskLabels(
  db: Database,
  taskId: string,
  labelIds: string[],
): Promise<void> {
  const unique = [...new Set(labelIds)];

  if (unique.length > 0) {
    const found = await db
      .select({ id: labels.id })
      .from(labels)
      .where(inArray(labels.id, unique));
    if (found.length !== unique.length) {
      throw validationError('包含不存在的标签');
    }
  }

  await db.delete(taskLabels).where(eq(taskLabels.taskId, taskId));
  if (unique.length > 0) {
    await db
      .insert(taskLabels)
      .values(unique.map((labelId) => ({ taskId, labelId })));
  }
}
