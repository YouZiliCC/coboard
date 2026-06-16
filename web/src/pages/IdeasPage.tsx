import { useState } from 'react';
import { Check, Lightbulb, Plus, Send, Trash2, X } from 'lucide-react';
import type { IdeaStatus, IdeaWithContext } from 'shared';
import { adoptIdeaInputSchema, createStandaloneIdeaInputSchema, ideaStatuses } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '../components/ui';
import { avatarUrl } from '../lib/utils';
import { isApiClientError } from '../api/client';
import {
  useAdoptIdea,
  useAllIdeas,
  useCreateStandaloneIdea,
  useDeleteIdea,
  useRejectIdea,
} from '../api/ideas';
import { useAuth } from '../lib/auth-context';
import { relativeTime } from '../features/board/format';
import { IDEA_STATUS_LABELS } from '../features/task/IdeaSection';
import { TaskDetailDrawer } from '../features/task/TaskDetailDrawer';
import type { BadgeVariant } from '../components/ui';

/**
 * 灵感区 (§7.1) — a board of every idea the current user can see (admins: all). Two
 * kinds of cards:
 * - TASK ideas: show their owning project + task title; clicking opens the task
 *   detail drawer on the 想法 tab (current behavior).
 * - STANDALONE ideas (no task/project, posted here via 「发布灵感」): show a
 *   「独立想法」 badge, are non-clickable, and a global admin can adopt/reject them
 *   inline (since there is no task drawer to host the action).
 *
 * A status filter narrows the list; adopted ideas credit reward points to the author.
 */

const IDEA_STATUS_VARIANT: Record<IdeaStatus, BadgeVariant> = {
  pending: 'neutral',
  adopted: 'success',
  rejected: 'destructive',
};

/** Sentinel for "all statuses" in the filter select (Radix needs a non-empty value). */
const ALL_STATUSES = 'all';

export default function IdeasPage(): JSX.Element {
  const { user, isAdmin } = useAuth();
  const [status, setStatus] = useState<IdeaStatus | typeof ALL_STATUSES>(ALL_STATUSES);
  // Clicking a TASK idea opens its task detail drawer in-place (no navigation away).
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
              汇集你可见项目下的想法，以及面向所有人的独立灵感。被采纳的想法会为作者计入奖励点数。
            </p>
          </div>
          <div className="flex items-center gap-2">
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
            <PublishIdeaDialog />
          </div>
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
            description="点击「发布灵感」分享一个独立想法，或在任务详情页的「想法 / 灵感」区分享灵感。"
          />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                canManage={isAdmin}
                canDelete={isAdmin || idea.author.id === user?.id}
                onOpen={
                  idea.taskId != null && idea.projectId != null
                    ? () => setSelected({ taskId: idea.taskId!, projectId: idea.projectId! })
                    : undefined
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

/** 「发布灵感」 — a small dialog with a body textarea posting a STANDALONE idea. */
function PublishIdeaDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createIdea = useCreateStandaloneIdea();

  function reset(): void {
    setBody('');
    setError(null);
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    const parsed = createStandaloneIdeaInputSchema.safeParse({ body: body.trim() });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '想法不能为空');
      return;
    }
    createIdea.mutate(parsed.data, {
      onSuccess: () => {
        reset();
        setOpen(false);
      },
      onError: (err) =>
        setError(isApiClientError(err) ? err.message : '发布失败，请稍后重试'),
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="md">
          <Plus className="h-4 w-4" aria-hidden />
          发布灵感
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>发布灵感</DialogTitle>
          <DialogDescription>
            分享一个不依附于任何任务的独立想法，对所有成员可见。被管理员采纳后将为你计入奖励点数。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="grid gap-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={5}
            autoFocus
            placeholder="分享一个想法或灵感…支持 Markdown"
            aria-label="想法内容"
            invalid={!!error}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                handleSubmit(e);
              }
            }}
          />
          {error && <p className="text-xs text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                reset();
                setOpen(false);
              }}
            >
              取消
            </Button>
            <Button type="submit" loading={createIdea.isPending} disabled={!body.trim()}>
              {!createIdea.isPending && <Send className="h-3.5 w-3.5" aria-hidden />}
              发布
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IdeaCard({
  idea,
  canManage,
  canDelete,
  onOpen,
}: {
  idea: IdeaWithContext;
  /** Whether the current user (global admin) may adopt/reject a standalone idea. */
  canManage: boolean;
  /** Whether the current user (global admin / author) may delete this idea. */
  canDelete: boolean;
  /** Opens the owning task drawer; undefined for a STANDALONE idea (no task). */
  onOpen?: () => void;
}): JSX.Element {
  const isStandalone = idea.taskId == null;
  const deleteIdea = useDeleteIdea();

  /** Overlaid 删除 button (top-right); kept out of the clickable task-card button. */
  const deleteButton = canDelete ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="absolute right-2 top-2 z-10 h-7 w-7 bg-card/80 text-muted-foreground hover:text-destructive"
      aria-label="删除想法"
      loading={deleteIdea.isPending}
      onClick={(e) => {
        e.stopPropagation();
        if (window.confirm('确定删除这个想法？')) {
          deleteIdea.mutate({ ideaId: idea.id, taskId: idea.taskId ?? undefined });
        }
      }}
    >
      {!deleteIdea.isPending && <Trash2 className="h-3.5 w-3.5" aria-hidden />}
    </Button>
  ) : null;

  const head = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {isStandalone ? (
          <Badge variant="primary">独立想法</Badge>
        ) : (
          <Badge variant="outline" className="font-mono">
            {idea.projectName}
          </Badge>
        )}
        <Badge variant={IDEA_STATUS_VARIANT[idea.status]}>
          {IDEA_STATUS_LABELS[idea.status]}
        </Badge>
        {idea.status === 'adopted' && idea.rewardPoints != null && (
          <Badge variant="primary">奖励 {idea.rewardPoints} 点</Badge>
        )}
      </div>

      {!isStandalone && (
        <p className="truncate text-sm font-medium text-foreground">{idea.taskTitle}</p>
      )}

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
    </>
  );

  // TASK idea: the whole card is a button that opens the task drawer (current
  // behavior). The 删除 control is overlaid OUTSIDE the button (no nested buttons).
  if (!isStandalone && onOpen) {
    return (
      <div className="relative">
        {deleteButton}
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {head}
        </button>
      </div>
    );
  }

  // STANDALONE idea (no task drawer): a non-clickable card, with inline admin actions.
  return (
    <div className="relative flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left shadow-sm">
      {deleteButton}
      {head}
      {isStandalone && canManage && idea.status === 'pending' && (
        <StandaloneIdeaActions idea={idea} />
      )}
    </div>
  );
}

/** Inline 采纳（填奖励点数）/ 驳回 for a STANDALONE idea, shown to global admins. */
function StandaloneIdeaActions({ idea }: { idea: IdeaWithContext }): JSX.Element {
  const [adopting, setAdopting] = useState(false);
  const [reward, setReward] = useState('');
  const [error, setError] = useState<string | null>(null);

  const adoptIdea = useAdoptIdea();
  const rejectIdea = useRejectIdea();

  function submitAdopt(): void {
    setError(null);
    const value = reward.trim() ? Number(reward) : NaN;
    const parsed = adoptIdeaInputSchema.safeParse({ rewardPoints: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请输入有效的奖励点数');
      return;
    }
    // Standalone idea: no owning task to invalidate (taskId omitted).
    adoptIdea.mutate(
      { ideaId: idea.id, input: parsed.data },
      {
        onSuccess: () => {
          setAdopting(false);
          setReward('');
        },
        onError: (err) =>
          setError(isApiClientError(err) ? err.message : '采纳失败，请稍后重试'),
      },
    );
  }

  return (
    <div>
      {adopting ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min={0}
            inputMode="numeric"
            className="w-28"
            placeholder="奖励点数"
            aria-label="奖励点数"
            value={reward}
            onChange={(e) => setReward(e.target.value)}
          />
          <Button type="button" size="sm" loading={adoptIdea.isPending} onClick={submitAdopt}>
            <Check className="h-3.5 w-3.5" aria-hidden />
            确认采纳
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setAdopting(false);
              setError(null);
            }}
          >
            取消
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={() => setAdopting(true)}>
            <Check className="h-3.5 w-3.5" aria-hidden />
            采纳
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={rejectIdea.isPending}
            onClick={() => rejectIdea.mutate({ ideaId: idea.id })}
          >
            <X className="h-3.5 w-3.5" aria-hidden />
            驳回
          </Button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
