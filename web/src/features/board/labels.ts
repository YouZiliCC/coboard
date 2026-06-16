import type { ActivityType, Priority, TaskStatus } from 'shared';
import type { BadgeVariant } from '../../components/ui';

/**
 * Centralized Chinese labels and presentation metadata for board enums (§12 i18n).
 * Code identifiers stay English; UI copy is Chinese. Kept feature-local since
 * only the board/task features consume these.
 */

/** Board column order (lifecycle v2 §5): 待认领 → 进行中 → 待审阅 → 已完成. */
export const COLUMN_ORDER: readonly TaskStatus[] = [
  'open',
  'in_progress',
  'pending_review',
  'done',
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  open: '待认领',
  in_progress: '进行中',
  pending_review: '待审阅',
  done: '已完成',
};

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};

/** Badge variant + dot color per priority for consistent visual weight. */
export const PRIORITY_BADGE: Record<Priority, { variant: BadgeVariant; dot: string }> = {
  low: { variant: 'outline', dot: 'bg-muted-foreground/50' },
  medium: { variant: 'neutral', dot: 'bg-primary/60' },
  high: { variant: 'warning', dot: 'bg-warning' },
  urgent: { variant: 'destructive', dot: 'bg-destructive' },
};

/** Human-readable, fill-in-the-blanks templates for the activity timeline (§5). */
export const ACTIVITY_LABELS: Record<ActivityType, string> = {
  created: '创建了任务',
  claimed: '认领了任务',
  assigned: '指派了任务',
  unassigned: '取消了指派',
  released: '释放了任务',
  status_changed: '变更了状态',
  completed: '通过了审阅',
  reopened: '重新打开了任务',
  commented: '发表了评论',
  updated: '更新了任务',
  delivered: '交付了任务',
  rejected: '驳回了交付',
};
