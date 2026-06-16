import type { ActivityWithActor, TaskStatus } from 'shared';
import { Avatar, Spinner } from '../../components/ui';
import { avatarUrl } from '../../lib/utils';
import { formatDateTime } from '../board/format';
import { ACTIVITY_LABELS, STATUS_LABELS } from '../board/labels';

/**
 * Activity timeline (§5 activities, §6). A chronological log of what happened to
 * a task — created/claimed/assigned/released/completed/etc. The `status_changed`
 * entry surfaces its from/to states from `meta`.
 */
export interface ActivityTimelineProps {
  activities: ActivityWithActor[];
  isLoading: boolean;
}

function asStatusLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value in STATUS_LABELS) return STATUS_LABELS[value as TaskStatus];
  return value;
}

/** Build the human description for one activity, including from/to if present. */
function describe(activity: ActivityWithActor): string {
  const base = ACTIVITY_LABELS[activity.type];
  if (activity.type === 'status_changed') {
    const from = asStatusLabel(activity.meta['from']);
    const to = asStatusLabel(activity.meta['to']);
    if (from && to) return `将状态从「${from}」变更为「${to}」`;
  }
  if (activity.type === 'delivered') {
    const total = activity.meta['totalPoints'];
    if (typeof total === 'number') return `${base}（共 ${total} 点）`;
  }
  if (activity.type === 'rejected') {
    const comment = activity.meta['comment'];
    if (typeof comment === 'string' && comment.trim()) {
      return `${base}：${comment}`;
    }
  }
  return base;
}

export function ActivityTimeline({ activities, isLoading }: ActivityTimelineProps): JSX.Element {
  if (isLoading) {
    return (
      <div className="py-4 text-center">
        <Spinner label="加载动态" />
      </div>
    );
  }

  if (activities.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">暂无动态</p>;
  }

  return (
    <ol className="relative flex flex-col gap-4 border-l border-border pl-4">
      {activities.map((activity) => (
        <li key={activity.id} className="relative">
          <span
            className="absolute -left-[1.3125rem] top-1.5 h-2 w-2 rounded-full bg-border ring-4 ring-card"
            aria-hidden
          />
          <div className="flex items-start gap-2">
            <Avatar
              name={activity.actor.displayName}
              color={activity.actor.avatarColor}
              imageUrl={activity.actor.hasAvatar ? avatarUrl(activity.actor.id) : undefined}
              size="xs"
            />
            <div className="min-w-0 flex-1 text-sm">
              <span className="font-medium text-foreground">
                {activity.actor.displayName}
              </span>{' '}
              <span className="text-muted-foreground">{describe(activity)}</span>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatDateTime(activity.createdAt)}
              </div>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
