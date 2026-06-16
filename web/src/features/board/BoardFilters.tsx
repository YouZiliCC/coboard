import { Check, Filter, Tag, UserCircle2 } from 'lucide-react';
import type { Label, ProjectMemberWithUser } from 'shared';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui';
import { cn, readableTextColor } from '../../lib/utils';

/**
 * Board filters (§6.1, §11 "我的任务" cross-project view as a filter). Quick filters:
 * "我的任务" (assignee = current user), a per-assignee dropdown, and a label filter
 * dropdown (task-labels). State is lifted to the board page so it can filter the
 * cached task list.
 */

/** Special filter sentinel values. */
export const FILTER_ALL = '__all__';
export const FILTER_ME = '__me__';
/** Concrete filter value: a member user id, FILTER_ALL, or FILTER_ME. */
export type AssigneeFilter = string;
/** Label filter sentinel: no label filter applied. */
export const LABEL_FILTER_ALL = '__all__';
/** Concrete label filter value: a label id, or LABEL_FILTER_ALL. */
export type LabelFilter = string;

export interface BoardFiltersProps {
  value: AssigneeFilter;
  onChange: (value: AssigneeFilter) => void;
  members: ProjectMemberWithUser[];
  /** Current user id, to label/enable "我的任务". */
  currentUserId: string | undefined;
  /**
   * Whether the per-assignee dropdown applies (§8). False in the 全部项目 view, where
   * there is no single project member list — only the 我的任务 quick toggle is shown.
   */
  membersOnly?: boolean;
  /** The global label catalog, for the label filter dropdown (task-labels). */
  labels?: Label[];
  /** Current label filter (a label id or LABEL_FILTER_ALL). */
  labelFilter?: LabelFilter;
  onLabelFilterChange?: (value: LabelFilter) => void;
}

export function BoardFilters({
  value,
  onChange,
  members,
  currentUserId,
  membersOnly = true,
  labels = [],
  labelFilter = LABEL_FILTER_ALL,
  onLabelFilterChange,
}: BoardFiltersProps): JSX.Element {
  const isMine = value === FILTER_ME;
  const selectedMember =
    value !== FILTER_ALL && value !== FILTER_ME
      ? members.find((m) => m.userId === value)
      : undefined;

  const dropdownLabel = selectedMember ? selectedMember.user.displayName : '全部成员';

  const selectedLabel =
    labelFilter !== LABEL_FILTER_ALL
      ? labels.find((l) => l.id === labelFilter)
      : undefined;
  const showLabelFilter = !!onLabelFilterChange && labels.length > 0;

  return (
    <div className="flex items-center gap-2">
      {/* "我的任务" quick toggle */}
      <Button
        type="button"
        variant={isMine ? 'primary' : 'outline'}
        size="sm"
        disabled={!currentUserId}
        onClick={() => onChange(isMine ? FILTER_ALL : FILTER_ME)}
        aria-pressed={isMine}
      >
        <UserCircle2 className="h-3.5 w-3.5" aria-hidden />
        我的任务
      </Button>

      {/* Per-assignee dropdown — scoped to a single project's members (§8). */}
      {membersOnly && (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm">
            <Filter className="h-3.5 w-3.5" aria-hidden />
            <span className="max-w-[8rem] truncate">{dropdownLabel}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
          <DropdownMenuLabel>按负责人筛选</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onChange(FILTER_ALL)}>
            <span className="flex-1">全部成员</span>
            {value === FILTER_ALL && <Check className="h-3.5 w-3.5" aria-hidden />}
          </DropdownMenuItem>
          {members.map((m) => (
            <DropdownMenuItem
              key={m.userId}
              onSelect={() => onChange(m.userId)}
              className={cn(value === m.userId && 'bg-accent text-accent-foreground')}
            >
              <span className="flex-1 truncate">
                {m.user.displayName}
                {m.userId === currentUserId && (
                  <span className="ml-1 text-xs text-muted-foreground">（我）</span>
                )}
              </span>
              {value === m.userId && <Check className="h-3.5 w-3.5" aria-hidden />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      {/* Label filter dropdown (task-labels) */}
      {showLabelFilter && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              <Tag className="h-3.5 w-3.5" aria-hidden />
              <span className="max-w-[8rem] truncate">
                {selectedLabel ? selectedLabel.name : '全部标签'}
              </span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
            <DropdownMenuLabel>按标签筛选</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onLabelFilterChange?.(LABEL_FILTER_ALL)}>
              <span className="flex-1">全部标签</span>
              {labelFilter === LABEL_FILTER_ALL && (
                <Check className="h-3.5 w-3.5" aria-hidden />
              )}
            </DropdownMenuItem>
            {labels.map((label) => (
              <DropdownMenuItem
                key={label.id}
                onSelect={() => onLabelFilterChange?.(label.id)}
                className={cn(
                  labelFilter === label.id && 'bg-accent text-accent-foreground',
                )}
              >
                <span
                  className="mr-2 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: label.color, color: readableTextColor(label.color) }}
                  aria-hidden
                />
                <span className="flex-1 truncate">{label.name}</span>
                {labelFilter === label.id && <Check className="h-3.5 w-3.5" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
