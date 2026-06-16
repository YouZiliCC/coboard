import { QueryClient } from '@tanstack/react-query';
import { isApiClientError } from '../api/client';

/**
 * Shared TanStack Query client (§3). Conservative defaults: realtime freshness is
 * driven primarily by SSE invalidation (§6.5), so we keep a short stale time and
 * avoid retrying genuine client errors (4xx) which won't succeed on retry.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // Don't retry auth/permission/validation/not-found/conflict errors.
        if (isApiClientError(error) && error.status >= 400 && error.status < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Centralized query-key factory so feature hooks and the SSE layer agree on keys.
 * Downstream agents extend this; keep keys structured (array form) for partial
 * invalidation (e.g. invalidate all of a project's tasks).
 */
export const queryKeys = {
  setupStatus: () => ['setup', 'status'] as const,
  registrationStatus: () => ['auth', 'registration'] as const,
  settings: () => ['settings'] as const,
  me: () => ['auth', 'me'] as const,
  users: () => ['users'] as const,
  projects: () => ['projects'] as const,
  projectDirectory: () => ['projects', 'directory'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  projectMembers: (projectId: string) => ['projects', projectId, 'members'] as const,
  board: (projectId: string) => ['projects', projectId, 'tasks'] as const,
  task: (taskId: string) => ['tasks', taskId] as const,
  comments: (taskId: string) => ['tasks', taskId, 'comments'] as const,
  activities: (taskId: string) => ['tasks', taskId, 'activities'] as const,
  leaderboard: (params: Record<string, string | undefined>) =>
    ['stats', 'leaderboard', params] as const,
  myStats: (params: Record<string, string | undefined>) =>
    ['stats', 'me', params] as const,
  trend: (params: Record<string, string | undefined>) =>
    ['stats', 'trend', params] as const,
};
