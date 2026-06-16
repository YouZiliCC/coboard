import { Trophy, Hash } from 'lucide-react';
import type { StatsSort } from 'shared';
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui';
import { useProjects } from '../../api/projects';
import { cn } from '../../lib/utils';
import {
  ALL_PROJECTS,
  type ProjectFilter,
  type StatFilterState,
  type TimeRangePreset,
} from './types';

/**
 * Filter bar for the contribution-stats page (§6.4 维度): project (全部 / 单个),
 * time range (本周 / 本月 / 全部 / 自定义起止), and sort (完成数 / 点数). Pure
 * controlled component — the page owns the {@link StatFilterState}.
 */

interface StatFiltersProps {
  value: StatFilterState;
  onChange: (next: StatFilterState) => void;
}

const RANGE_OPTIONS: ReadonlyArray<{ value: TimeRangePreset; label: string }> = [
  { value: 'week', label: '本周' },
  { value: 'month', label: '本月' },
  { value: 'all', label: '全部' },
  { value: 'custom', label: '自定义' },
];

const SORT_OPTIONS: ReadonlyArray<{
  value: StatsSort;
  label: string;
  icon: typeof Trophy;
}> = [
  { value: 'count', label: '完成数', icon: Trophy },
  { value: 'points', label: '点数', icon: Hash },
];

export function StatFilters({ value, onChange }: StatFiltersProps): JSX.Element {
  const { data: projects } = useProjects();
  const activeProjects = (projects ?? []).filter((p) => !p.archived);

  const patch = (partial: Partial<StatFilterState>): void => {
    onChange({ ...value, ...partial });
  };

  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-4 rounded-xl border border-border bg-card p-4">
      {/* Project filter */}
      <div className="flex min-w-[10rem] flex-col gap-1.5">
        <Label htmlFor="stat-project">项目</Label>
        <Select
          value={value.project}
          onValueChange={(next: ProjectFilter) => patch({ project: next })}
        >
          <SelectTrigger id="stat-project" aria-label="项目筛选">
            <SelectValue placeholder="全部项目" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROJECTS}>全部项目</SelectItem>
            {activeProjects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Time range preset */}
      <div className="flex flex-col gap-1.5">
        <Label>时间范围</Label>
        <div
          className="inline-flex rounded-md border border-input bg-background p-0.5"
          role="group"
          aria-label="时间范围"
        >
          {RANGE_OPTIONS.map((option) => {
            const selected = value.range === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => patch({ range: option.value })}
                className={cn(
                  'rounded px-3 py-1 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Custom range inputs — only when 自定义 is selected */}
      {value.range === 'custom' && (
        <div className="flex w-full items-end gap-2 sm:w-auto">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-none">
            <Label htmlFor="stat-from">起</Label>
            <Input
              id="stat-from"
              type="date"
              className="w-full sm:w-[9.5rem]"
              value={value.customFrom}
              max={value.customTo || undefined}
              onChange={(e) => patch({ customFrom: e.target.value })}
            />
          </div>
          <span className="pb-2 text-muted-foreground" aria-hidden>
            —
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-none">
            <Label htmlFor="stat-to">止</Label>
            <Input
              id="stat-to"
              type="date"
              className="w-full sm:w-[9.5rem]"
              value={value.customTo}
              min={value.customFrom || undefined}
              onChange={(e) => patch({ customTo: e.target.value })}
            />
          </div>
        </div>
      )}

      {/* Sort */}
      <div className="ml-auto flex flex-col gap-1.5">
        <Label>排序</Label>
        <div
          className="inline-flex rounded-md border border-input bg-background p-0.5"
          role="group"
          aria-label="排序方式"
        >
          {SORT_OPTIONS.map((option) => {
            const selected = value.sort === option.value;
            const Icon = option.icon;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={selected}
                onClick={() => patch({ sort: option.value })}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
