import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import type {
  AdoptIdeaInput,
  CreateIdeaInput,
  CreateStandaloneIdeaInput,
  Idea,
  IdeaResponse,
  IdeasResponse,
  IdeaStatus,
  IdeasWithContextResponse,
  IdeaWithContext,
} from 'shared';
import { api } from './client';
import { queryKeys } from '../lib/query';

/**
 * Idea / inspiration hooks (§7.1). Two listing surfaces:
 * - a single task's ideas (rendered in the task detail drawer), and
 * - the cross-project 灵感区 listing (the /ideas page) with an optional status filter.
 *
 * Mutations (post / adopt / reject) invalidate BOTH the idea queries and the stats
 * queries — adopting an idea credits the author's contribution points (§7.1). SSE
 * also refreshes peers via the `idea`/`task` channels (§6.5).
 */

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

/**
 * Unwrap the single-element `{ ideas: [...] }` create response to the lone Idea
 * (mirrors the comments hook's unwrap convention).
 */
async function unwrapIdea(promise: Promise<IdeasResponse>): Promise<Idea> {
  const res = await promise;
  const idea = res.ideas[0];
  if (!idea) {
    throw new Error('服务器未返回想法数据');
  }
  return idea;
}

export const ideasApi = {
  forTask: (taskId: string, signal?: AbortSignal): Promise<IdeasResponse> =>
    api.get<IdeasResponse>(`/tasks/${taskId}/ideas`, { signal }),
  create: (taskId: string, body: CreateIdeaInput): Promise<Idea> =>
    unwrapIdea(api.post<IdeasResponse>(`/tasks/${taskId}/ideas`, body)),
  createStandalone: (body: CreateStandaloneIdeaInput): Promise<Idea> =>
    api.post<IdeaResponse>('/ideas', body).then((r) => r.idea),
  all: (
    params: { status?: IdeaStatus },
    signal?: AbortSignal,
  ): Promise<IdeasWithContextResponse> =>
    api.get<IdeasWithContextResponse>('/ideas', {
      query: { status: params.status },
      signal,
    }),
  adopt: (ideaId: string, body: AdoptIdeaInput): Promise<Idea> =>
    api.post<IdeaResponse>(`/ideas/${ideaId}/adopt`, body).then((r) => r.idea),
  reject: (ideaId: string): Promise<Idea> =>
    api.post<IdeaResponse>(`/ideas/${ideaId}/reject`).then((r) => r.idea),
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Ideas posted against a task (§7.1 GET /tasks/:id/ideas), newest first. */
export function useTaskIdeas(taskId: string | undefined): UseQueryResult<Idea[]> {
  return useQuery<Idea[]>({
    queryKey: taskId ? queryKeys.taskIdeas(taskId) : ['tasks', '__none__', 'ideas'],
    queryFn: async ({ signal }) => {
      const res = await ideasApi.forTask(taskId!, signal);
      return res.ideas;
    },
    enabled: taskId !== undefined,
  });
}

export interface AllIdeasParams {
  status?: IdeaStatus;
}

/** All ideas across the caller's visible projects (§7.1 GET /ideas). */
export function useAllIdeas(params: AllIdeasParams): UseQueryResult<IdeaWithContext[]> {
  return useQuery<IdeaWithContext[]>({
    queryKey: queryKeys.ideas({ status: params.status }),
    queryFn: async ({ signal }) => {
      const res = await ideasApi.all(params, signal);
      return res.ideas;
    },
  });
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Invalidate every idea listing + the stats queries after an idea mutation. */
function invalidateIdeas(
  queryClient: ReturnType<typeof useQueryClient>,
  taskId?: string,
): void {
  if (taskId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.taskIdeas(taskId) });
  }
  // Loose prefix: refresh the 灵感区 across every status filter.
  void queryClient.invalidateQueries({ queryKey: ['ideas'] });
  // Adopting/rejecting shifts contribution points (§7.1).
  void queryClient.invalidateQueries({ queryKey: ['stats'] });
}

/** Post an idea on a task (§7.1 POST /tasks/:id/ideas). */
export function useCreateIdea(taskId: string): UseMutationResult<Idea, Error, CreateIdeaInput> {
  const queryClient = useQueryClient();
  return useMutation<Idea, Error, CreateIdeaInput>({
    mutationFn: (body) => ideasApi.create(taskId, body),
    onSuccess: () => invalidateIdeas(queryClient, taskId),
  });
}

/**
 * Post a STANDALONE idea in the 灵感区 (§7.1 POST /ideas; any logged-in user). No
 * task is involved, so only the cross-project idea list + stats are invalidated.
 */
export function useCreateStandaloneIdea(): UseMutationResult<
  Idea,
  Error,
  CreateStandaloneIdeaInput
> {
  const queryClient = useQueryClient();
  return useMutation<Idea, Error, CreateStandaloneIdeaInput>({
    mutationFn: (body) => ideasApi.createStandalone(body),
    onSuccess: () => invalidateIdeas(queryClient),
  });
}

export interface AdoptIdeaVars {
  ideaId: string;
  input: AdoptIdeaInput;
  /** Owning task id, so the task's idea list can be invalidated. */
  taskId?: string;
}

/** Adopt an idea + grant reward points (§7.1 POST /ideas/:id/adopt; lead/admin). */
export function useAdoptIdea(): UseMutationResult<Idea, Error, AdoptIdeaVars> {
  const queryClient = useQueryClient();
  return useMutation<Idea, Error, AdoptIdeaVars>({
    mutationFn: ({ ideaId, input }) => ideasApi.adopt(ideaId, input),
    onSuccess: (_idea, { taskId }) => invalidateIdeas(queryClient, taskId),
  });
}

export interface RejectIdeaVars {
  ideaId: string;
  /** Owning task id, so the task's idea list can be invalidated. */
  taskId?: string;
}

/** Reject an idea (§7.1 POST /ideas/:id/reject; lead/admin). */
export function useRejectIdea(): UseMutationResult<Idea, Error, RejectIdeaVars> {
  const queryClient = useQueryClient();
  return useMutation<Idea, Error, RejectIdeaVars>({
    mutationFn: ({ ideaId }) => ideasApi.reject(ideaId),
    onSuccess: (_idea, { taskId }) => invalidateIdeas(queryClient, taskId),
  });
}
