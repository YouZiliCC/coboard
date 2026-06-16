import type { FastifyPluginAsync } from 'fastify';
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import setupRoutes from './routes/setup.js';
import projectsRoutes from './routes/projects.js';
import tasksRoutes from './routes/tasks.js';
import labelsRoutes from './routes/labels.js';
import commentsRoutes from './routes/comments.js';
import ideasRoutes from './routes/ideas.js';
import taskFilesRoutes from './routes/task-files.js';
import statsRoutes from './routes/stats.js';
import streamRoutes from './routes/stream.js';
import settingsRoutes from './routes/settings.js';

/**
 * Explicit route registration. In production `@fastify/autoload` scans the
 * `routes/` directory; in tests (Vitest), autoload's native dynamic import
 * bypasses the Vite transform, so the app builder registers routes through this
 * static map instead. Kept OUTSIDE `routes/` so autoload does not treat it as the
 * directory's index plugin. Keep this list in sync with the route files.
 */
export const registerRoutes: FastifyPluginAsync = async (fastify) => {
  await fastify.register(authRoutes);
  await fastify.register(usersRoutes);
  await fastify.register(setupRoutes);
  await fastify.register(projectsRoutes);
  await fastify.register(tasksRoutes);
  await fastify.register(labelsRoutes);
  await fastify.register(commentsRoutes);
  await fastify.register(ideasRoutes);
  await fastify.register(taskFilesRoutes);
  await fastify.register(statsRoutes);
  await fastify.register(streamRoutes);
  await fastify.register(settingsRoutes);
};
