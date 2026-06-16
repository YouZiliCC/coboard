import { useState } from 'react';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { createLabelInputSchema } from 'shared';
import { Button, Input, Spinner } from '../../components/ui';
import { isApiClientError } from '../../api/client';
import { useCreateLabel, useDeleteLabel, useLabels } from '../../api/labels';
import { useAuth } from '../../lib/auth-context';
import { cn, readableTextColor } from '../../lib/utils';

/**
 * Reusable label picker (task-labels feature). Shows the global label catalog as
 * toggleable colored chips (multi-select) and an inline 「新建标签」 affordance
 * (name input + a small preset color palette) that POSTs a new label and selects it.
 * Global admins additionally get a small trash on each chip to delete a label from
 * the catalog. Used by CreateTaskDialog (choose labels at creation) and the
 * TaskDetailDrawer edit form (edit a task's labels → PATCH labelIds).
 *
 * Controlled: the parent owns the selected id set via `value` / `onChange`.
 */

/** A small preset palette so new labels get consistent, readable colors. */
const PRESET_COLORS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#10b981',
  '#06b6d4',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
] as const;

export interface LabelPickerProps {
  /** Currently selected label ids. */
  value: string[];
  onChange: (next: string[]) => void;
  className?: string;
}

export function LabelPicker({ value, onChange, className }: LabelPickerProps): JSX.Element {
  const { isAdmin } = useAuth();
  const { data: labels, isLoading } = useLabels();
  const createLabel = useCreateLabel();
  const deleteLabel = useDeleteLabel();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(PRESET_COLORS[7]);
  const [error, setError] = useState<string | null>(null);

  const selected = new Set(value);

  function toggle(id: string): void {
    if (selected.has(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  function resetCreate(): void {
    setCreating(false);
    setName('');
    setColor(PRESET_COLORS[7]);
    setError(null);
  }

  function submitCreate(): void {
    setError(null);
    const parsed = createLabelInputSchema.safeParse({ name: name.trim(), color });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    createLabel.mutate(parsed.data, {
      onSuccess: (label) => {
        onChange([...value, label.id]);
        resetCreate();
      },
      onError: (err) => {
        setError(
          isApiClientError(err) ? err.message : '创建标签失败，请稍后重试',
        );
      },
    });
  }

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {isLoading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> 加载标签…
        </div>
      ) : (labels ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">还没有标签，点击下方新建。</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {(labels ?? []).map((label) => {
            const isOn = selected.has(label.id);
            const fg = readableTextColor(label.color);
            return (
              <span key={label.id} className="inline-flex items-center">
                <button
                  type="button"
                  onClick={() => toggle(label.id)}
                  aria-pressed={isOn}
                  aria-label={`${isOn ? '取消选择' : '选择'}标签 ${label.name}`}
                  className={cn(
                    'inline-flex max-w-[12rem] items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-none transition-opacity',
                    !isOn && 'opacity-50 hover:opacity-80',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  )}
                  style={{ backgroundColor: label.color, color: fg }}
                >
                  {isOn && <Check className="h-3 w-3 shrink-0" aria-hidden />}
                  <span className="truncate">{label.name}</span>
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    aria-label={`删除标签 ${label.name}`}
                    title="从标签库删除"
                    disabled={deleteLabel.isPending}
                    onClick={() => {
                      if (
                        window.confirm(
                          `从标签库删除「${label.name}」？该标签会从所有任务上移除。`,
                        )
                      ) {
                        deleteLabel.mutate(label.id, {
                          onSuccess: () => onChange(value.filter((v) => v !== label.id)),
                        });
                      }
                    }}
                    className="-ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      {/* Inline create */}
      {creating ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <Input
            autoFocus
            value={name}
            placeholder="标签名称"
            maxLength={30}
            invalid={!!error}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitCreate();
              }
            }}
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`选择颜色 ${c}`}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  'h-6 w-6 rounded-full ring-offset-2 ring-offset-background transition-transform',
                  color === c ? 'ring-2 ring-ring' : 'hover:scale-110',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              loading={createLabel.isPending}
              disabled={!name.trim()}
              onClick={submitCreate}
            >
              添加
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={resetCreate}>
              <X className="h-3.5 w-3.5" aria-hidden />
              取消
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="inline-flex w-fit items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
        >
          <Plus className="h-3 w-3" aria-hidden />
          新建标签
        </button>
      )}
    </div>
  );
}
