import type { FastifyPluginAsync } from 'fastify';
import {
  createLabelInputSchema,
  idParamSchema,
  updateLabelInputSchema,
  type LabelResponse,
  type LabelsResponse,
} from 'shared';
import { requireAdmin, requireAuth } from '../lib/guards.js';
import { parseBody, parseParams } from '../lib/validate.js';
import {
  createLabel,
  deleteLabel,
  listLabels,
  updateLabel,
} from '../services/labelService.js';

/**
 * Label catalog routes (task-labels feature). The catalog is GLOBAL — one shared set
 * of `{ name, color }` labels across every project/task. Any logged-in user may read
 * the catalog or create a label (so labels can be added inline while tagging a task);
 * renaming / recoloring / deleting a label is reserved for global admins. Deleting a
 * label cascades it off every task (FK ON DELETE CASCADE).
 */
const labelsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  // GET /labels — the whole shared catalog (any logged-in user).
  fastify.get('/labels', async (request): Promise<LabelsResponse> => {
    requireAuth(request);
    const labels = await listLabels(db);
    return { labels };
  });

  // POST /labels — create a catalog label (any logged-in user; 409 on dup name).
  fastify.post('/labels', async (request, reply): Promise<LabelResponse> => {
    const user = requireAuth(request);
    const input = parseBody(createLabelInputSchema, request.body);
    const label = await createLabel(db, user.id, input);
    reply.code(201);
    return { label };
  });

  // PATCH /labels/:id — rename / recolor (global admin only).
  fastify.patch('/labels/:id', async (request): Promise<LabelResponse> => {
    requireAdmin(request);
    const { id } = parseParams(idParamSchema, request.params);
    const input = parseBody(updateLabelInputSchema, request.body);
    const label = await updateLabel(db, id, input);
    return { label };
  });

  // DELETE /labels/:id — delete + cascade off tasks (global admin only).
  fastify.delete('/labels/:id', async (request, reply): Promise<void> => {
    requireAdmin(request);
    const { id } = parseParams(idParamSchema, request.params);
    await deleteLabel(db, id);
    reply.code(204);
  });
};

export default labelsRoutes;
