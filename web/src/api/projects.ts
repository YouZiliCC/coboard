import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AddProjectMemberInput,
  CreateProjectInput,
  Project,
  ProjectDirectoryItem,
  ProjectDirectoryResponse,
  ProjectMembersResponse,
  ProjectMemberWithUser,
  ProjectsListResponse,
  UpdateProjectInput,
} from 'shared';
import { api } from './client';
import { queryKeys } from '../lib/query';

/**
 * Single-project response wrapper for POST /projects and PATCH /projects/:id.
 *
 * NOTE (contract gap): `packages/shared` defines `taskResponseSchema = { task }`
 * but ships no analogous `projectResponseSchema` / `ProjectResponse`. We mirror
 * the established `{ entity }` convention here and flag it for reconciliation in
 * the integration phase. If the server wraps differently, only this type changes.
 */
interface ProjectResponse {
  project: Project;
}

/**
 * Project data hooks (§7). Read hooks come from the foundation; the Admin
 * frontend agent adds the mutation hooks (create/update/archive, member
 * management) below — additive only, read hooks left intact.
 *
 * Conventions:
 * - Reuse {@link projectsApi} for fetchers and `queryKeys.project*` for keys.
 * - Mutations `invalidateQueries({ queryKey: queryKeys.projects() })`
 *   (and the affected members key); SSE also refreshes peers (§6.5).
 */

/** Low-level fetchers — shared by hooks and mutation onSuccess refetches. */
export const projectsApi = {
  list: (signal?: AbortSignal): Promise<ProjectsListResponse> =>
    api.get<ProjectsListResponse>('/projects', { signal }),
  create: (input: CreateProjectInput): Promise<ProjectResponse> =>
    api.post<ProjectResponse>('/projects', input),
  update: (id: string, input: UpdateProjectInput): Promise<ProjectResponse> =>
    api.patch<ProjectResponse>(`/projects/${id}`, input),
  directory: (signal?: AbortSignal): Promise<ProjectDirectoryResponse> =>
    api.get<ProjectDirectoryResponse>('/projects/directory', { signal }),
  join: (id: string): Promise<{ ok: boolean }> =>
    api.post<{ ok: boolean }>(`/projects/${id}/join`),
  leave: (id: string): Promise<{ ok: boolean }> =>
    api.post<{ ok: boolean }>(`/projects/${id}/leave`),
  members: (id: string, signal?: AbortSignal): Promise<ProjectMembersResponse> =>
    api.get<ProjectMembersResponse>(`/projects/${id}/members`, { signal }),
  addMember: (id: string, input: AddProjectMemberInput): Promise<ProjectMembersResponse> =>
    api.post<ProjectMembersResponse>(`/projects/${id}/members`, input),
  removeMember: (id: string, userId: string): Promise<void> =>
    api.delete<void>(`/projects/${id}/members/${userId}`),
};

/** All projects visible to the current user (§7 GET /projects). */
export function useProjects(): UseQueryResult<Project[]> {
  return useQuery<Project[]>({
    queryKey: queryKeys.projects(),
    queryFn: async ({ signal }) => {
      const res = await projectsApi.list(signal);
      return res.projects;
    },
  });
}

/**
 * A single project by id, resolved from the projects list cache. There is no
 * dedicated `GET /projects/:id` in the contract (§7); the list is the source.
 */
export function useProject(projectId: string | undefined): UseQueryResult<Project | undefined> {
  return useQuery<Project[], Error, Project | undefined>({
    queryKey: queryKeys.projects(),
    queryFn: async ({ signal }) => {
      const res = await projectsApi.list(signal);
      return res.projects;
    },
    enabled: projectId !== undefined,
    select: (projects) => projects.find((p) => p.id === projectId),
  });
}

/**
 * Self-service project directory — every non-archived project, each flagged with
 * whether the current user is a member and its member count (§7 GET
 * /projects/directory). Powers the browsable 项目 page where any user can join/leave.
 */
export function useProjectDirectory(): UseQueryResult<ProjectDirectoryItem[]> {
  return useQuery<ProjectDirectoryItem[]>({
    queryKey: queryKeys.projectDirectory(),
    queryFn: async ({ signal }) => {
      const res = await projectsApi.directory(signal);
      return res.projects;
    },
  });
}

// ---------------------------------------------------------------------------
// Members (read) — §7 GET /projects/:id/members
// ---------------------------------------------------------------------------

/** Members of a project, joined with their user (§7 GET /projects/:id/members). */
export function useProjectMembers(
  projectId: string | undefined,
): UseQueryResult<ProjectMemberWithUser[]> {
  return useQuery<ProjectMemberWithUser[]>({
    queryKey: projectId ? queryKeys.projectMembers(projectId) : ['projects', 'unknown', 'members'],
    queryFn: async ({ signal }) => {
      const res = await projectsApi.members(projectId as string, signal);
      return res.members;
    },
    enabled: projectId !== undefined,
  });
}

// ---------------------------------------------------------------------------
// Mutations — admin/lead project + member management (§6.3, §7)
// ---------------------------------------------------------------------------

/** Create a project (admin) — §7 POST /projects. */
export function useCreateProject(): UseMutationResult<Project, Error, CreateProjectInput> {
  const queryClient = useQueryClient();
  return useMutation<Project, Error, CreateProjectInput>({
    mutationFn: async (input) => {
      const res = await projectsApi.create(input);
      return res.project;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
  });
}

interface UpdateProjectVariables {
  id: string;
  input: UpdateProjectInput;
}

/** Edit / archive a project — §7 PATCH /projects/:id. */
export function useUpdateProject(): UseMutationResult<Project, Error, UpdateProjectVariables> {
  const queryClient = useQueryClient();
  return useMutation<Project, Error, UpdateProjectVariables>({
    mutationFn: async ({ id, input }) => {
      const res = await projectsApi.update(id, input);
      return res.project;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
  });
}

interface AddMemberVariables {
  projectId: string;
  input: AddProjectMemberInput;
}

/** Add a member (or set/update their lead/member role) — §7 POST /projects/:id/members. */
export function useAddProjectMember(): UseMutationResult<
  ProjectMemberWithUser[],
  Error,
  AddMemberVariables
> {
  const queryClient = useQueryClient();
  return useMutation<ProjectMemberWithUser[], Error, AddMemberVariables>({
    mutationFn: async ({ projectId, input }) => {
      const res = await projectsApi.addMember(projectId, input);
      return res.members;
    },
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectMembers(projectId) });
      // Adding/removing membership can change which projects a user sees.
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
  });
}

interface RemoveMemberVariables {
  projectId: string;
  userId: string;
}

/** Remove a member — §7 DELETE /projects/:id/members/:userId. */
export function useRemoveProjectMember(): UseMutationResult<void, Error, RemoveMemberVariables> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, RemoveMemberVariables>({
    mutationFn: ({ projectId, userId }) => projectsApi.removeMember(projectId, userId),
    onSuccess: (_data, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectMembers(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    },
  });
}

// ---------------------------------------------------------------------------
// Self-service join / leave (§6.3, §7) — affect only the current user
// ---------------------------------------------------------------------------

/**
 * Refresh both the caller's own project list (powers the switcher/board nav) and
 * the directory after a self-join/leave changes membership.
 */
function invalidateMembershipQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.projectDirectory() });
}

/** Self-join a project as a member — §7 POST /projects/:id/join. */
export function useJoinProject(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (projectId) => {
      await projectsApi.join(projectId);
    },
    onSuccess: () => invalidateMembershipQueries(queryClient),
  });
}

/** Self-leave a project — §7 POST /projects/:id/leave (409 if sole lead). */
export function useLeaveProject(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: async (projectId) => {
      await projectsApi.leave(projectId);
    },
    onSuccess: () => invalidateMembershipQueries(queryClient),
  });
}
