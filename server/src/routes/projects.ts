import type { FastifyPluginAsync } from 'fastify';
import {
  addProjectMemberInputSchema,
  createProjectInputSchema,
  idParamSchema,
  projectMemberParamsSchema,
  updateProjectInputSchema,
  type ProjectDirectoryResponse,
  type ProjectMembersResponse,
  type ProjectsListResponse,
} from 'shared';
import {
  requireAdmin,
  requireAuth,
  requireProjectLead,
  requireProjectMember,
} from '../lib/guards.js';
import { parseBody, parseParams } from '../lib/validate.js';
import {
  addProjectMember,
  createProject,
  joinProject,
  leaveProject,
  listProjectDirectory,
  listProjectMembers,
  listVisibleProjects,
  removeProjectMember,
  updateProject,
} from '../services/projectService.js';

/**
 * Project & membership routes (§6.3, §7). Handlers stay thin: run the auth/project
 * guards, validate the body/params against the shared zod contracts, then delegate
 * to projectService. Visibility (non-members cannot see a project) and lead/admin
 * mutation rules live in the guards + service.
 *
 *   GET    /projects                       — projects I can see (admin: all)
 *   GET    /projects/directory             — any user; all non-archived projects
 *   POST   /projects                       — admin; auto-adds creator as lead
 *   PATCH  /projects/:id                   — lead/admin; rename/describe/archive
 *   POST   /projects/:id/join              — any user; self-join as member
 *   POST   /projects/:id/leave             — any user; self-leave
 *   GET    /projects/:id/members           — project members (member-visible)
 *   POST   /projects/:id/members           — lead/admin; add a user with a role
 *   DELETE /projects/:id/members/:userId   — lead/admin; remove a member
 */
const projectsRoutes: FastifyPluginAsync = async (fastify) => {
  const { db } = fastify;

  // List the projects the current user can see.
  fastify.get('/projects', async (request): Promise<ProjectsListResponse> => {
    const user = requireAuth(request);
    const projects = await listVisibleProjects(db, user);
    return { projects };
  });

  // Browsable directory of all non-archived projects (any logged-in user).
  // Registered ahead of the `/projects/:id`-style routes; Fastify matches this
  // static path before the parametric ones, and there is no `GET /projects/:id`.
  fastify.get(
    '/projects/directory',
    async (request): Promise<ProjectDirectoryResponse> => {
      const user = requireAuth(request);
      const projects = await listProjectDirectory(db, user.id);
      return { projects };
    },
  );

  // Create a project (admin only); the creator becomes its lead.
  fastify.post('/projects', async (request, reply) => {
    const admin = requireAdmin(request);
    const input = parseBody(createProjectInputSchema, request.body);
    const project = await createProject(db, admin, input);
    return reply.code(201).send({ project });
  });

  // Update a project; lead or global admin only.
  fastify.patch('/projects/:id', async (request) => {
    const { id } = parseParams(idParamSchema, request.params);
    await requireProjectLead(db, request, id);
    const input = parseBody(updateProjectInputSchema, request.body);
    const project = await updateProject(db, id, input);
    return { project };
  });

  // Self-join a project as a member (any logged-in user); idempotent.
  fastify.post('/projects/:id/join', async (request) => {
    const user = requireAuth(request);
    const { id } = parseParams(idParamSchema, request.params);
    await joinProject(db, user.id, id);
    return { ok: true };
  });

  // Self-leave a project (any logged-in user); 409 if sole remaining lead.
  fastify.post('/projects/:id/leave', async (request) => {
    const user = requireAuth(request);
    const { id } = parseParams(idParamSchema, request.params);
    await leaveProject(db, user.id, id);
    return { ok: true };
  });

  // List a project's members; any member (or admin) may view.
  fastify.get(
    '/projects/:id/members',
    async (request): Promise<ProjectMembersResponse> => {
      const { id } = parseParams(idParamSchema, request.params);
      await requireProjectMember(db, request, id);
      const members = await listProjectMembers(db, id);
      return { members };
    },
  );

  // Add a member; lead or global admin only.
  fastify.post('/projects/:id/members', async (request, reply) => {
    const { id } = parseParams(idParamSchema, request.params);
    await requireProjectLead(db, request, id);
    const input = parseBody(addProjectMemberInputSchema, request.body);
    const member = await addProjectMember(db, id, input);
    return reply.code(201).send({ member });
  });

  // Remove a member; lead or global admin only.
  fastify.delete('/projects/:id/members/:userId', async (request, reply) => {
    const { id, userId } = parseParams(projectMemberParamsSchema, request.params);
    await requireProjectLead(db, request, id);
    await removeProjectMember(db, id, userId);
    return reply.code(204).send();
  });
};

export default projectsRoutes;
