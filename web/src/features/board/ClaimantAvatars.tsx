import type { TaskClaimant } from 'shared';
import { Avatar } from '../../components/ui';
import type { AvatarSize } from '../../components/ui';
import { avatarUrl, cn } from '../../lib/utils';

/**
 * Stacked claimant avatars (lifecycle v2 §5). Renders up to `max` overlapping
 * avatars; any overflow collapses into a trailing "+N" chip. Order follows the
 * claimants array (claim order). Purely presentational.
 */
export interface ClaimantAvatarsProps {
  claimants: TaskClaimant[];
  /** Max avatars before collapsing into +N. */
  max?: number;
  size?: AvatarSize;
  className?: string;
}

export function ClaimantAvatars({
  claimants,
  max = 3,
  size = 'xs',
  className,
}: ClaimantAvatarsProps): JSX.Element | null {
  if (claimants.length === 0) return null;
  const shown = claimants.slice(0, max);
  const overflow = claimants.length - shown.length;

  return (
    <div
      className={cn('flex items-center', className)}
      aria-label={`${claimants.length} 位认领者`}
    >
      <div className="flex -space-x-2">
        {shown.map((c) => (
          <Avatar
            key={c.userId}
            name={c.displayName}
            color={c.avatarColor}
            imageUrl={c.hasAvatar ? avatarUrl(c.userId) : undefined}
            size={size}
            className="ring-2 ring-card"
          />
        ))}
        {overflow > 0 && (
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-secondary text-[10px] font-medium text-muted-foreground ring-2 ring-card"
            title={`还有 ${overflow} 位`}
          >
            +{overflow}
          </span>
        )}
      </div>
    </div>
  );
}
