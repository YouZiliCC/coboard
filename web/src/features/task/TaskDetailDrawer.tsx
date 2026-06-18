import { useState } from 'react';
import {
  CalendarClock,
  Check,
  Lightbulb,
  MessageSquare,
  PackageCheck,
  Pencil,
  History,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import type { Priority, Task } from 'shared';
import { updateTaskInputSchema, type UpdateTaskInput } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Textarea,
} from '../../components/ui';
import { useAuth } from '../../lib/auth-context';
import { avatarUrl } from '../../lib/utils';
import {
  useAssignTask,
  usePatchTask,
  useProjectMembers,
  useReleaseTask,
  useTask,
  useDeleteTask,
} from '../../api/tasks';
import { useActivities, useComments } from '../../api/comments';
import { ClaimButton } from '../board/ClaimButton';
import { ClaimLimitBadge } from '../board/ClaimLimitBadge';
import { DeliverDialog } from '../board/DeliverDialog';
import { ReviewActions } from '../board/ReviewActions';
import { RevokeApprovalButton } from '../board/RevokeApprovalButton';
import { dueInfo } from '../board/format';
import { PRIORITY_BADGE, PRIORITY_LABELS, STATUS_LABELS } from '../board/labels';
import {
  canAssign,
  canDeleteTask,
  canDeliver,
  canEditTask,
  canReview,
  canRevokeApproval,
  isClaimant,
  isManager,
  resolveProjectRole,
} from '../board/permissions';
import { LabelChip } from '../board/LabelChip';
import { LabelPicker } from '../board/LabelPicker';
import { renderMarkdown } from './markdown';
import { CommentComposer } from './CommentComposer';
import { CommentList } from './CommentList';
import { ActivityTimeline } from './ActivityTimeline';
import { IdeaSection } from './IdeaSection';
import { AttachmentSection } from './AttachmentSection';
import { TextDeliverySection } from './TextDeliverySection';
import { useTaskIdeas } from '../../api/ideas';

/**
 * Task detail drawer (lifecycle v2 §5). A right-side sheet opened from a board
 * card. Shows editable fields, the claimants list with each one's allocated points,
 * role-aware claim/release/assign + deliver/review actions, the comment thread
 * (markdown + @mentions, safely rendered), and the activity timeline (incl.
 * delivered/reviewed/rejected). All edits go through the optimistic task mutations.
 */
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
/** Only the direct board moves are PATCHable; deliver/review own the rest (§3). */
const STATUSES = ['open', 'in_progress'] as const;

type Tab = 'comments' | 'ideas' | 'activity';

export interface TaskDetailDrawerProps {
  taskId: string | null;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Which tab to open initially (defaults to 评论). */
  initialTab?: Tab;
}

export function TaskDetailDrawer({
  taskId,
  projectId,
  open,
  onOpenChange,
  initialTab,
}: TaskDetailDrawerProps): JSX.Element {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent widthClassName="w-full sm:max-w-2xl" className="gap-0 p-0" hideClose>
        {taskId ? (
          <DrawerInner taskId={taskId} projectId={projectId} initialTab={initialTab} onClose={() => onOpenChange(false)} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        )}
      </DrawerContent>
    </Drawer>
  );
}

interface DrawerInnerProps {
  taskId: string;
  projectId: string;
  initialTab?: Tab;
  onClose: () => void;
}

function DrawerInner({ taskId, projectId, initialTab, onClose }: DrawerInnerProps): JSX.Element {
  const { user } = useAuth();
  const { data: task, isLoading } = useTask(taskId);
  // Resolve members from the task's OWN project, not the board's `projectId` (which
  // is the "all" sentinel in the 全部项目 view). A no-project (pool) task has no
  // members, so the members query stays disabled (§8).
  const { data: members } = useProjectMembers(task?.projectId ?? undefined);
  const { data: comments, isLoading: commentsLoading } = useComments(taskId);
  const { data: ideas } = useTaskIdeas(taskId);
  const { data: activities, isLoading: activitiesLoading } = useActivities(taskId);

  const patchTask = usePatchTask(projectId);
  const assignTask = useAssignTask(projectId);
  const releaseTask = useReleaseTask(projectId, user?.id);
  const deleteTask = useDeleteTask(projectId);

  const [tab, setTab] = useState<Tab>(initialTab ?? 'comments');
  const [editing, setEditing] = useState(false);
  const [deliverOpen, setDeliverOpen] = useState(false);

  const projectRole = resolveProjectRole(members, user?.id);
  const permCtx = { user, projectRole };
  const memberList = members ?? [];

  if (isLoading || !task) {
    return (
      <>
        <DrawerHeader>
          <DrawerTitle>任务详情</DrawerTitle>
        </DrawerHeader>
        <div className="flex flex-1 items-center justify-center">
          <Spinner label="加载任务" />
        </div>
      </>
    );
  }

  const editable = canEditTask(permCtx, task);
  const deletable = canDeleteTask(permCtx, task);
  const assignable = canAssign(permCtx, task);
  const manager = isManager(permCtx, task);
  const showDeliver = canDeliver(permCtx, task);
  const showReview = canReview(permCtx, task);
  const showRevoke = canRevokeApproval(permCtx, task);
  const meClaimant = isClaimant(permCtx, task);

  const statusVariant =
    task.status === 'done'
      ? 'success'
      : task.status === 'pending_review'
        ? 'warning'
        : task.status === 'in_progress'
          ? 'primary'
          : 'neutral';

  // Members not yet claiming, for the assign dropdown.
  const claimantIds = new Set(task.claimants.map((c) => c.userId));
  const assignableMembers = memberList.filter((m) => !claimantIds.has(m.userId));

  return (
    <>
      <DrawerHeader className="flex flex-row items-center justify-between gap-2 pr-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={statusVariant}>{STATUS_LABELS[task.status]}</Badge>
          <Badge variant={PRIORITY_BADGE[task.priority].variant} className="gap-1">
            <span
              className={`h-1.5 w-1.5 rounded-full ${PRIORITY_BADGE[task.priority].dot}`}
              aria-hidden
            />
            {PRIORITY_LABELS[task.priority]}
          </Badge>
          {task.points != null && <Badge variant="outline">{task.points} 点</Badge>}
        </div>
        <div className="flex items-center gap-1">
          {editable && !editing && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="编辑任务"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" aria-hidden />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="关闭"
            onClick={onClose}
          >
            <X className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </DrawerHeader>

      <DrawerBody className="flex flex-col gap-6">
        {editing && editable ? (
          <TaskEditForm
            task={task}
            onCancel={() => setEditing(false)}
            onSave={(patch) =>
              patchTask.mutate(
                { taskId: task.id, patch },
                { onSuccess: () => setEditing(false) },
              )
            }
            saving={patchTask.isPending}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <DrawerTitle className="text-xl leading-snug break-words">{task.title}</DrawerTitle>
            {task.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((label) => (
                  <LabelChip key={label.id} label={label} />
                ))}
              </div>
            )}
            {task.description ? (
              <div className="break-words">{renderMarkdown(task.description)}</div>
            ) : (
              <p className="text-sm italic text-muted-foreground">暂无描述</p>
            )}
          </div>
        )}

        {/* Deliver / review / revoke-approval action bar */}
        {(showDeliver ||
          showReview ||
          showRevoke ||
          (task.status === 'pending_review' && !showReview)) && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-secondary/30 p-3">
            {/* Submitter line — shown to everyone (reviewer or not) while a task awaits
                review, on its own row, so 待审阅 tasks prominently show 谁交付的. */}
            {task.status === 'pending_review' && (
              <div className="flex w-full min-w-0 items-center gap-1.5 text-sm">
                <PackageCheck className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                {task.deliverer ? (
                  <>
                    <span className="shrink-0 text-muted-foreground">提交人</span>
                    <span className="min-w-0 truncate font-medium text-foreground">
                      {task.deliverer.displayName}
                    </span>
                    <span className="shrink-0 text-muted-foreground">· 已交付，等待审阅</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">已交付，等待审阅</span>
                )}
              </div>
            )}
            {showDeliver && (
              <Button type="button" size="sm" onClick={() => setDeliverOpen(true)}>
                <PackageCheck className="h-4 w-4" aria-hidden />
                交付（分配点数）
              </Button>
            )}
            {showReview && <ReviewActions task={task} projectId={projectId} size="md" />}
            {showRevoke && <RevokeApprovalButton task={task} projectId={projectId} size="md" />}
          </div>
        )}

        {/* Meta + claimants */}
        <div className="grid gap-3 rounded-lg border border-border bg-secondary/30 p-3">
          {/* Claimants list */}
          <div className="flex items-start gap-3">
            <span className="w-16 shrink-0 pt-1 text-xs font-medium text-muted-foreground">
              认领者
            </span>
            <div className="flex flex-1 flex-col gap-2">
              {/* Claim-count limits summary (claim-limits) */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>
                  下限 {task.minClaimants} 人 · 上限{' '}
                  {task.maxClaimants != null ? `${task.maxClaimants} 人` : '不限'} · 已认领{' '}
                  {task.claimants.length} 人
                </span>
                <ClaimLimitBadge task={task} />
              </div>
              {task.claimants.length === 0 ? (
                <span className="text-sm text-muted-foreground">暂无认领者</span>
              ) : (
                task.claimants.map((c) => {
                  const canRemove = c.userId === user?.id || manager;
                  return (
                    <div key={c.userId} className="flex items-center gap-2">
                      <Avatar
                        name={c.displayName}
                        color={c.avatarColor}
                        imageUrl={c.hasAvatar ? avatarUrl(c.userId) : undefined}
                        size="xs"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{c.displayName}</span>
                      {c.points != null && (
                        <Badge variant="primary" className="ml-1 shrink-0">
                          {c.points} 点
                        </Badge>
                      )}
                      {canRemove && (task.status === 'open' || task.status === 'in_progress') && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="ml-auto h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label={`移除 ${c.displayName}`}
                          loading={releaseTask.isPending}
                          onClick={() =>
                            releaseTask.mutate({ taskId: task.id, userId: c.userId })
                          }
                        >
                          <UserMinus className="h-3.5 w-3.5" aria-hidden />
                        </Button>
                      )}
                    </div>
                  );
                })
              )}

              {/* Claim + assign controls */}
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <ClaimButton task={task} projectId={projectId} size="sm" />
                {meClaimant && (task.status === 'open' || task.status === 'in_progress') && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={releaseTask.isPending}
                    onClick={() => releaseTask.mutate({ taskId: task.id })}
                  >
                    <UserMinus className="h-3.5 w-3.5" aria-hidden />
                    退出认领
                  </Button>
                )}
                {assignable && assignableMembers.length > 0 && task.status !== 'done' && (
                  <Select
                    value=""
                    onValueChange={(value) => {
                      const m = assignableMembers.find((x) => x.userId === value);
                      assignTask.mutate({
                        taskId: task.id,
                        assigneeId: value,
                        ...(m
                          ? {
                              assignee: {
                                displayName: m.user.displayName,
                                avatarColor: m.user.avatarColor,
                                hasAvatar: m.user.hasAvatar,
                              },
                            }
                          : {}),
                      });
                    }}
                  >
                    <SelectTrigger className="h-8 w-36 text-xs">
                      <span className="inline-flex items-center gap-1">
                        <UserPlus className="h-3.5 w-3.5" aria-hidden />
                        <SelectValue placeholder="派发给…" />
                      </span>
                    </SelectTrigger>
                    <SelectContent>
                      {assignableMembers.map((m) => (
                        <SelectItem key={m.userId} value={m.userId}>
                          {m.user.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
          </div>

          {/* 交付人 / 审阅人 — compact, tightly-stacked rows below the claimants. Only
              shown once a task has LEFT review (done, or reverted to 进行中/待认领 after
              a 驳回); while pending_review the submitter is shown prominently in the
              review bar above instead, and a stale reviewer from an earlier reject is
              not surfaced. */}
          {task.status !== 'pending_review' && (task.deliverer || task.reviewer) && (
            <div className="flex flex-col gap-1 text-xs">
              {task.deliverer && (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="w-12 shrink-0 font-medium text-muted-foreground">交付人</span>
                  <span className="min-w-0 truncate text-foreground">
                    {task.deliverer.displayName}
                  </span>
                </div>
              )}
              {task.reviewer && (
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className="w-12 shrink-0 font-medium text-muted-foreground">审阅人</span>
                  <span className="min-w-0 truncate text-foreground">
                    {task.reviewer.displayName}
                  </span>
                  <Badge
                    variant={task.status === 'done' ? 'success' : 'neutral'}
                    className="shrink-0"
                  >
                    {task.status === 'done' ? '通过' : '驳回'}
                  </Badge>
                </div>
              )}
            </div>
          )}

          {/* Status quick-move (open ↔ in_progress only; editable) */}
          {editable && (task.status === 'open' || task.status === 'in_progress') && (
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">状态</span>
              <div className="flex flex-1 flex-wrap gap-1.5">
                {STATUSES.map((status) => {
                  // Can't move into 进行中 below the claim lower bound — the task must
                  // stay in 待认领 (未达下限) until enough people claim (claim-limits).
                  const blockedByMin =
                    status === 'in_progress' && task.claimants.length < task.minClaimants;
                  return (
                    <Button
                      key={status}
                      type="button"
                      variant={task.status === status ? 'primary' : 'outline'}
                      size="sm"
                      disabled={task.status === status || blockedByMin}
                      title={
                        blockedByMin
                          ? `未达领取人数下限（${task.claimants.length}/${task.minClaimants}）`
                          : undefined
                      }
                      onClick={() =>
                        patchTask.mutate({ taskId: task.id, patch: { status } })
                      }
                    >
                      {task.status === status && <Check className="h-3.5 w-3.5" aria-hidden />}
                      {STATUS_LABELS[status]}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Due date */}
          {task.dueDate && (
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">截止</span>
              <DueLabel dueDate={task.dueDate} />
            </div>
          )}
        </div>

        {/* Attachments — used to deliver file content (§7.2) */}
        <TextDeliverySection task={task} permCtx={permCtx} />

        <AttachmentSection task={task} permCtx={permCtx} />

        {/* Tabs: comments / activity */}
        <div>
          <div className="mb-3 flex items-center gap-1 border-b border-border">
            <TabButton
              active={tab === 'comments'}
              onClick={() => setTab('comments')}
              icon={<MessageSquare className="h-4 w-4" aria-hidden />}
              label={`评论${comments ? ` (${comments.length})` : ''}`}
            />
            <TabButton
              active={tab === 'ideas'}
              onClick={() => setTab('ideas')}
              icon={<Lightbulb className="h-4 w-4" aria-hidden />}
              label={`想法${ideas ? ` (${ideas.length})` : ''}`}
            />
            <TabButton
              active={tab === 'activity'}
              onClick={() => setTab('activity')}
              icon={<History className="h-4 w-4" aria-hidden />}
              label="动态"
            />
          </div>

          {tab === 'comments' ? (
            <div className="flex flex-col gap-4">
              <CommentList
                task={task}
                comments={comments ?? []}
                isLoading={commentsLoading}
                members={memberList}
                permCtx={permCtx}
              />
              <CommentComposer taskId={task.id} members={memberList} />
            </div>
          ) : tab === 'ideas' ? (
            <IdeaSection task={task} permCtx={permCtx} />
          ) : (
            <ActivityTimeline activities={activities ?? []} isLoading={activitiesLoading} />
          )}
        </div>
      </DrawerBody>

      {deletable && (
        <DrawerFooter className="justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            loading={deleteTask.isPending}
            onClick={() => {
              if (window.confirm('确定删除这个任务？此操作不可撤销。')) {
                deleteTask.mutate(task.id, { onSuccess: onClose });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            删除任务
          </Button>
        </DrawerFooter>
      )}

      {showDeliver && (
        <DeliverDialog
          task={task}
          projectId={projectId}
          open={deliverOpen}
          onOpenChange={setDeliverOpen}
        />
      )}
    </>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
      aria-pressed={active}
    >
      {icon}
      {label}
    </button>
  );
}

function DueLabel({ dueDate }: { dueDate: string }): JSX.Element {
  const due = dueInfo(dueDate);
  return (
    <span
      className={`inline-flex items-center gap-1 text-sm ${
        due.overdue
          ? 'font-medium text-destructive'
          : due.soon
            ? 'text-warning-foreground'
            : 'text-foreground'
      }`}
    >
      <CalendarClock className="h-3.5 w-3.5" aria-hidden />
      {dueDate}
      {due.overdue && <span className="text-xs">（已逾期）</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Inline edit form
// ---------------------------------------------------------------------------

interface TaskEditFormProps {
  task: Task;
  onCancel: () => void;
  onSave: (patch: UpdateTaskInput) => void;
  saving: boolean;
}

function TaskEditForm({ task, onCancel, onSave, saving }: TaskEditFormProps): JSX.Element {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description ?? '');
  const [priority, setPriority] = useState<Priority>(task.priority);
  const [points, setPoints] = useState(task.points != null ? String(task.points) : '');
  const [minClaimants, setMinClaimants] = useState(String(task.minClaimants));
  const [maxClaimants, setMaxClaimants] = useState(
    task.maxClaimants != null ? String(task.maxClaimants) : '',
  );
  const [dueDate, setDueDate] = useState(task.dueDate ?? '');
  const [labelIds, setLabelIds] = useState<string[]>(task.labels.map((l) => l.id));
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent): void {
    e.preventDefault();
    setError(null);
    const patch: UpdateTaskInput = {
      title: title.trim(),
      description: description.trim() ? description.trim() : null,
      priority,
      points: points.trim() ? Number(points) : null,
      // Claim limits (claim-limits): min coerced to a number; max null = unlimited.
      minClaimants: minClaimants.trim() ? Number(minClaimants) : 1,
      maxClaimants: maxClaimants.trim() ? Number(maxClaimants) : null,
      dueDate: dueDate ? dueDate : null,
      // REPLACE set: the task's labels become exactly the chosen ids.
      labelIds,
    };
    const parsed = updateTaskInputSchema.safeParse(patch);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    onSave(parsed.data);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor="edit-title" required>
          标题
        </Label>
        <Input
          id="edit-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          invalid={!title.trim()}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="edit-desc">描述（支持 Markdown）</Label>
        <Textarea
          id="edit-desc"
          rows={5}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label>优先级</Label>
          <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-points">点数</Label>
          <Input
            id="edit-points"
            type="number"
            min={0}
            value={points}
            onChange={(e) => setPoints(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-due">截止</Label>
          <Input
            id="edit-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="edit-min-claimants">认领人数下限</Label>
          <Input
            id="edit-min-claimants"
            type="number"
            min={1}
            value={minClaimants}
            onChange={(e) => setMinClaimants(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">达到该人数才进入「进行中」。</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="edit-max-claimants">认领人数上限</Label>
          <Input
            id="edit-max-claimants"
            type="number"
            min={1}
            placeholder="留空＝不限"
            value={maxClaimants}
            onChange={(e) => setMaxClaimants(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">达到上限后不再接受认领。</p>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label>标签</Label>
        <LabelPicker value={labelIds} onChange={setLabelIds} />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" loading={saving} disabled={!title.trim()}>
          保存
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}
