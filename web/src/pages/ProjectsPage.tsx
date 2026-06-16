import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, LayoutGrid, LogOut, Users as UsersIcon } from 'lucide-react';
import type { ProjectDirectoryItem } from 'shared';
import { Badge, Button, EmptyState, Spinner } from '../components/ui';
import { isApiClientError } from '../api/client';
import {
  useJoinProject,
  useLeaveProject,
  useProjectDirectory,
} from '../api/projects';

/**
 * Project directory (§6.3) — a browsable list of every non-archived project that
 * any logged-in user can self-join as a `member` or leave. Mirrors the admin
 * ProjectsTab card styling (name + key badge + description + member count). Join/
 * leave only ever affect the caller's own membership; the server enforces authz
 * (e.g. the sole-lead 409 surfaced inline below).
 */
export default function ProjectsPage(): JSX.Element {
  const { data: projects, isLoading, isError, refetch } = useProjectDirectory();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="px-4 py-6 sm:px-6">
        <EmptyState
          icon={Compass}
          title="加载项目失败"
          description="请检查网络后重试。"
          action={
            <Button variant="outline" onClick={() => void refetch()}>
              重新加载
            </Button>
          }
        />
      </div>
    );
  }

  const list = projects ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-6">
      <div>
        <h1 className="text-base font-semibold">项目</h1>
        <p className="text-sm text-muted-foreground">
          共 {list.length} 个项目。加入感兴趣的项目即可查看其看板。
        </p>
      </div>

      {list.length === 0 ? (
        <EmptyState
          icon={Compass}
          title="还没有可加入的项目"
          description="等待管理员创建项目后，这里会列出所有可加入的项目。"
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((project) => (
            <DirectoryCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A single directory card with the join / enter+leave actions. */
function DirectoryCard({ project }: { project: ProjectDirectoryItem }): JSX.Element {
  const navigate = useNavigate();
  const joinProject = useJoinProject();
  const leaveProject = useLeaveProject();
  const [error, setError] = useState<string | null>(null);

  async function handleJoin(): Promise<void> {
    setError(null);
    try {
      await joinProject.mutateAsync(project.id);
    } catch (err) {
      setError(isApiClientError(err) ? err.message : '加入失败，请稍后重试');
    }
  }

  async function handleLeave(): Promise<void> {
    setError(null);
    try {
      await leaveProject.mutateAsync(project.id);
    } catch (err) {
      setError(isApiClientError(err) ? err.message : '退出失败，请稍后重试');
    }
  }

  return (
    <article className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="truncate font-semibold text-foreground">{project.name}</h2>
          <Badge variant="outline" className="font-mono">
            {project.key}
          </Badge>
          {project.isMember && <Badge variant="success">已加入</Badge>}
        </div>
        {project.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">
            {project.description}
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground/70">暂无描述</p>
        )}
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <UsersIcon className="h-3.5 w-3.5" aria-hidden />
          {project.memberCount} 名成员
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1">
        {project.isMember ? (
          <>
            <Button size="sm" onClick={() => navigate(`/board/${project.id}`)}>
              <LayoutGrid className="h-4 w-4" aria-hidden />
              进入看板
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleLeave()}
              loading={leaveProject.isPending}
            >
              <LogOut className="h-4 w-4" aria-hidden />
              退出项目
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => void handleJoin()}
            loading={joinProject.isPending}
          >
            加入
          </Button>
        )}
      </div>
    </article>
  );
}
