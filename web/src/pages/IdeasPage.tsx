import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import type { IdeaStatus, IdeaWithContext } from 'shared';
import { ideaStatuses } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '../components/ui';
import { avatarUrl } from '../lib/utils';
import { useAllIdeas } from '../api/ideas';
import { relativeTime } from '../features/board/format';
import { IDEA_STATUS_LABELS } from '../features/task/IdeaSection';
import { TaskDetailDrawer } from '../features/task/TaskDetailDrawer';
import type { BadgeVariant } from '../components/ui';

/**
 * 灵感区 (§7.1) — a cross-project board of every idea the current user can see
 * (admins: all). One card per idea showing its task title + project, author, body
 * excerpt, status, and reward points (when adopted). A status filter narrows the
 * list; clicking a card jumps to the owning task (opens its detail drawer).
 */

const IDEA_STATUS_VARIANT: Record<IdeaStatus, BadgeVariant> = {
  pending: 'neutral',
  adopted: 'success',
  rejected: 'destructive',
};

/** Sentinel for "all statuses" in the filter select (Radix needs a non-empty value). */
const ALL_STATUSES = 'all';

export default function IdeasPage(): JSX.Element {
  const [status, setStatus] = useState<IdeaStatus | typeof ALL_STATUSES>(ALL_STATUSES);
  // Clicking an idea opens its task detail drawer in-place (no navigation away).
  const [selected, setSelected] = useState<{ taskId: string; projectId: string } | null>(null);
  const { data: ideas, isLoading, isError, refetch } = useAllIdeas({
    status: status === ALL_STATUSES ? undefined : status,
  });

  const list = ideas ?? [];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-4 px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold">
              <Lightbulb className="h-4 w-4 text-warning-foreground" aria-hidden />
              灵感区
            </h1>
            <p className="text-sm text-muted-foreground">
              汇集你可见项目下的所有想法。被采纳的想法会为作者计入奖励点数。
            </p>
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as IdeaStatus | typeof ALL_STATUSES)}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>全部状态</SelectItem>
              {ideaStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {IDEA_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Spinner label="加载想法" />
          </div>
        ) : isError ? (
          <EmptyState
            icon={Lightbulb}
            title="加载想法失败"
            description="请检查网络后重试。"
            action={
              <Button variant="outline" onClick={() => void refetch()}>
                重新加载
              </Button>
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={Lightbulb}
            title="还没有想法"
            description="在任务详情页的「想法 / 灵感」区分享你的第一个灵感吧。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                onOpen={() =>
                  setSelected({ taskId: idea.taskId, projectId: idea.projectId })
                }
              />
            ))}
          </div>
        )}
      </div>
      <TaskDetailDrawer
        taskId={selected?.taskId ?? null}
        projectId={selected?.projectId ?? ''}
        open={selected !== null}
        initialTab="ideas"
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      />
    </div>
  );
}

function IdeaCard({
  idea,
  onOpen,
}: {
  idea: IdeaWithContext;
  onOpen: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="font-mono">
          {idea.projectName}
        </Badge>
        <Badge variant={IDEA_STATUS_VARIANT[idea.status]}>
          {IDEA_STATUS_LABELS[idea.status]}
        </Badge>
        {idea.status === 'adopted' && idea.rewardPoints != null && (
          <Badge variant="primary">奖励 {idea.rewardPoints} 点</Badge>
        )}
      </div>

      <p className="truncate text-sm font-medium text-foreground">{idea.taskTitle}</p>

      <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
        {idea.body}
      </p>

      <div className="mt-auto flex items-center gap-2 pt-1">
        <Avatar
          name={idea.author.displayName}
          color={idea.author.avatarColor}
          imageUrl={idea.author.hasAvatar ? avatarUrl(idea.author.id) : undefined}
          size="xs"
        />
        <span className="text-xs text-foreground">{idea.author.displayName}</span>
        <span className="text-xs text-muted-foreground">{relativeTime(idea.createdAt)}</span>
      </div>
    </button>
  );
}
