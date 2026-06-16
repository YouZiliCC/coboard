import { useState } from 'react';
import { Check, Lightbulb, Send, Trash2, X } from 'lucide-react';
import type { Idea, IdeaStatus, Task } from 'shared';
import { adoptIdeaInputSchema, createIdeaInputSchema } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  Input,
  Spinner,
  Textarea,
  type BadgeVariant,
} from '../../components/ui';
import { avatarUrl } from '../../lib/utils';
import { isApiClientError } from '../../api/client';
import {
  useAdoptIdea,
  useCreateIdea,
  useDeleteIdea,
  useRejectIdea,
  useTaskIdeas,
} from '../../api/ideas';
import { relativeTime } from '../board/format';
import type { TaskPermissionContext } from '../board/permissions';
import { isManager } from '../board/permissions';
import { renderMarkdown } from './markdown';

/**
 * Idea / inspiration section (§7.1) inside the task detail drawer. A composer to
 * post an idea on the task plus the list of ideas (newest first). Each idea shows
 * its author, safely-rendered markdown body, and a status badge; leads/admins see
 * 采纳（输入奖励点数）/ 驳回 actions, and adopted ideas show their reward points.
 */

/** Chinese labels + badge variant per idea status (§12 i18n). */
export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  pending: '待处理',
  adopted: '已采纳',
  rejected: '已驳回',
};

const IDEA_STATUS_VARIANT: Record<IdeaStatus, BadgeVariant> = {
  pending: 'neutral',
  adopted: 'success',
  rejected: 'destructive',
};

export interface IdeaSectionProps {
  task: Task;
  permCtx: TaskPermissionContext;
}

export function IdeaSection({ task, permCtx }: IdeaSectionProps): JSX.Element {
  const taskId = task.id;
  const { data: ideas, isLoading } = useTaskIdeas(taskId);
  // Manager (admin / project lead, or pool-task creator) may adopt/reject + delete
  // any idea on this task; the author may delete their own (matches the server rule).
  const manager = isManager(permCtx, task);
  const myId = permCtx.user?.id;

  return (
    <div className="flex flex-col gap-4">
      {isLoading ? (
        <div className="py-4 text-center">
          <Spinner label="加载想法" />
        </div>
      ) : !ideas || ideas.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          还没有想法，欢迎分享你的灵感。
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {ideas.map((idea) => (
            <IdeaItem
              key={idea.id}
              idea={idea}
              canManage={manager}
              canDelete={manager || idea.author.id === myId}
            />
          ))}
        </ul>
      )}
      <IdeaComposer taskId={taskId} />
    </div>
  );
}

function IdeaItem({
  idea,
  canManage,
  canDelete,
}: {
  idea: Idea;
  canManage: boolean;
  canDelete: boolean;
}): JSX.Element {
  const [adopting, setAdopting] = useState(false);
  const [reward, setReward] = useState('');
  const [error, setError] = useState<string | null>(null);

  const adoptIdea = useAdoptIdea();
  const rejectIdea = useRejectIdea();
  const deleteIdea = useDeleteIdea();

  function submitAdopt(): void {
    setError(null);
    const value = reward.trim() ? Number(reward) : NaN;
    const parsed = adoptIdeaInputSchema.safeParse({ rewardPoints: value });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请输入有效的奖励点数');
      return;
    }
    adoptIdea.mutate(
      { ideaId: idea.id, input: parsed.data, taskId: idea.taskId ?? undefined },
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
    <li className="flex gap-3">
      <Avatar
        name={idea.author.displayName}
        color={idea.author.avatarColor}
        imageUrl={idea.author.hasAvatar ? avatarUrl(idea.author.id) : undefined}
        size="sm"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">
            {idea.author.displayName}
          </span>
          <span className="text-xs text-muted-foreground">{relativeTime(idea.createdAt)}</span>
          <Badge variant={IDEA_STATUS_VARIANT[idea.status]}>
            {IDEA_STATUS_LABELS[idea.status]}
          </Badge>
          {idea.status === 'adopted' && idea.rewardPoints != null && (
            <Badge variant="primary">奖励 {idea.rewardPoints} 点</Badge>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7 text-muted-foreground hover:text-destructive"
              aria-label="删除想法"
              loading={deleteIdea.isPending}
              onClick={() => {
                if (window.confirm('确定删除这个想法？')) {
                  deleteIdea.mutate({ ideaId: idea.id, taskId: idea.taskId ?? undefined });
                }
              }}
            >
              {!deleteIdea.isPending && <Trash2 className="h-3.5 w-3.5" aria-hidden />}
            </Button>
          )}
        </div>

        <div className="mt-1 break-words">{renderMarkdown(idea.body)}</div>

        {canManage && idea.status === 'pending' && (
          <div className="mt-2">
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
                <Button
                  type="button"
                  size="sm"
                  loading={adoptIdea.isPending}
                  onClick={submitAdopt}
                >
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
                  onClick={() => rejectIdea.mutate({ ideaId: idea.id, taskId: idea.taskId ?? undefined })}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                  驳回
                </Button>
              </div>
            )}
            {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          </div>
        )}
      </div>
    </li>
  );
}

function IdeaComposer({ taskId }: { taskId: string }): JSX.Element {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const createIdea = useCreateIdea(taskId);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    const parsed = createIdeaInputSchema.safeParse({ body: body.trim() });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '想法不能为空');
      return;
    }
    createIdea.mutate(parsed.data, {
      onSuccess: () => setBody(''),
      onError: (err) =>
        setError(isApiClientError(err) ? err.message : '发布失败，请稍后重试'),
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
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
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lightbulb className="h-3.5 w-3.5" aria-hidden />
          想法被采纳后，奖励点数将计入你的贡献
        </span>
        <Button type="submit" size="sm" loading={createIdea.isPending} disabled={!body.trim()}>
          {!createIdea.isPending && <Send className="h-3.5 w-3.5" aria-hidden />}
          发布想法
        </Button>
      </div>
    </form>
  );
}
