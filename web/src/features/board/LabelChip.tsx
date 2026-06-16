import type { Label } from 'shared';
import { cn, readableTextColor } from '../../lib/utils';

/**
 * A small colored label chip (task-labels feature). Renders the label name on a
 * background derived from the label color, with a readable foreground picked by
 * {@link readableTextColor}. Used on task cards and inside the LabelPicker.
 */
export interface LabelChipProps {
  label: Label;
  /** Optional trailing slot (e.g. a remove/check icon button). */
  trailing?: React.ReactNode;
  className?: string;
  title?: string;
}

export function LabelChip({ label, trailing, className, title }: LabelChipProps): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium leading-none',
        className,
      )}
      style={{ backgroundColor: label.color, color: readableTextColor(label.color) }}
      title={title ?? label.name}
    >
      <span className="truncate">{label.name}</span>
      {trailing}
    </span>
  );
}
