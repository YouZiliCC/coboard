import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { forwardRef, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * Modal dialog built on Radix Dialog (focus trap, escape, scroll lock, a11y).
 * Compose: <Dialog><DialogTrigger/><DialogContent>…</DialogContent></Dialog>.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const DialogOverlay = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] animate-overlay-in',
        className,
      )}
      {...props}
    />
  );
});

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /** Hide the default top-right close button. */
  hideClose?: boolean;
}

export const DialogContent = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, hideClose, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4',
          // Mobile-first: a side inset so the dialog never touches the phone edges;
          // sm+ restores the comfortable max width (consumers may override sm:max-w-*).
          'max-w-[calc(100vw-2rem)] sm:max-w-lg',
          // Cap the height with internal scroll so tall dialogs stay usable on short screens.
          'max-h-[calc(100vh-2rem)] overflow-y-auto',
          'rounded-xl border border-border bg-card p-6 text-card-foreground shadow-xl',
          'animate-content-in',
          className,
        )}
        {...props}
      >
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            className="absolute right-4 top-4 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('flex flex-col gap-1.5 text-left', className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      className={cn('text-lg font-semibold leading-none tracking-tight', className)}
      {...props}
    />
  );
});

export const DialogDescription = forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
});

/** Re-export for convenience when a child needs the raw content type. */
export type { ReactNode };
