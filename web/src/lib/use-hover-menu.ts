import { useCallback, useRef, useState } from 'react';

/**
 * Hover-to-open + click-to-pin behaviour for a Radix menu/popover that is
 * otherwise click-only (e.g. the project switcher, the user/avatar menu).
 *
 * - **Hover** the trigger → the menu opens as a *transient preview* that closes
 *   shortly after the pointer leaves both the trigger and the menu.
 * - **Click** the trigger → the menu is *pinned* open: it survives the pointer
 *   leaving, until an item is chosen, Escape, an outside click, or another click
 *   on the trigger.
 *
 * Wire-up:
 *   const menu = useHoverMenu();
 *   <DropdownMenu open={menu.open} onOpenChange={menu.onOpenChange} modal={false}>
 *     <DropdownMenuTrigger asChild {...menu.triggerProps}>
 *       <button> … </button>
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent {...menu.contentProps}> … </DropdownMenuContent>
 *   </DropdownMenu>
 *
 * Design: rather than fight Radix's built-in trigger toggle (which is merged onto
 * the asChild button by Slot and is awkward to suppress), this hook works *with*
 * it. Radix's toggle drives `onOpenChange`; the hook interprets each change using
 * a "did a trigger pointer-down cause this?" flag:
 *   - open  → pin (a real click/keyboard open).
 *   - close caused by a trigger click while only a hover *preview* → pin instead.
 *   - close caused by a trigger click while *pinned* → really close.
 *   - close from Escape / outside-click / item-select → really close.
 * `triggerProps` MUST go on `DropdownMenuTrigger` so its `onPointerDown` runs
 * before Radix's toggle (and thus sets the flag in time).
 *
 * `modal={false}` is REQUIRED: a modal Radix menu scroll-locks the page and traps
 * focus while open, which is hostile to a menu that opens merely on hover.
 */
export function useHoverMenu(closeDelay = 150) {
  const [open, setOpen] = useState(false);
  // Refs (not state) so the pointer/focus event handlers always read the live
  // value without depending on the render closure.
  const openRef = useRef(false);
  const pinnedRef = useRef(false);
  // True for the brief window in which a pointer-down on the trigger is driving
  // the current `onOpenChange` — lets us tell a trigger click apart from Escape /
  // outside-click / item-select.
  const triggerDownRef = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setOpenState = useCallback((next: boolean) => {
    openRef.current = next;
    setOpen(next);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    cancelClose();
    pinnedRef.current = false;
    setOpenState(false);
  }, [cancelClose, setOpenState]);

  const pin = useCallback(() => {
    cancelClose();
    pinnedRef.current = true;
    setOpenState(true);
  }, [cancelClose, setOpenState]);

  // The single funnel for every Radix-initiated open/close.
  const onOpenChange = useCallback(
    (next: boolean) => {
      cancelClose();
      if (next) {
        // Radix opened via a real click or keyboard → pin.
        pin();
        return;
      }
      if (triggerDownRef.current && !pinnedRef.current) {
        // A click on the trigger while it was only a hover preview → pin it open
        // instead of letting the toggle close it.
        pin();
        return;
      }
      // Genuine close: trigger click while pinned, Escape, outside-click, select.
      close();
    },
    [cancelClose, pin, close],
  );

  // Pointer entered the trigger → open as a transient (un-pinned) preview.
  const openOnHover = useCallback(() => {
    cancelClose();
    setOpenState(true);
  }, [cancelClose, setOpenState]);

  // Pointer left the trigger or the menu → close after a short grace period so
  // the pointer can cross the small gap between trigger and menu. Pinned menus
  // ignore pointer-leave entirely.
  const scheduleClose = useCallback(() => {
    cancelClose();
    if (pinnedRef.current) return;
    closeTimer.current = setTimeout(() => setOpenState(false), closeDelay);
  }, [cancelClose, closeDelay, setOpenState]);

  // Flag that the imminent `onOpenChange` (fired by Radix's toggle on the same
  // pointer-down) was driven by a trigger click. Cleared on the next macrotask,
  // after the synchronous toggle has read it.
  const onTriggerPointerDown = useCallback(() => {
    triggerDownRef.current = true;
    setTimeout(() => {
      triggerDownRef.current = false;
    }, 0);
  }, []);

  // Don't steal focus for a mere hover preview (would yank focus / scroll on
  // hover); allow it once pinned so keyboard users can navigate into the menu.
  const onContentOpenAutoFocus = useCallback((event: Event) => {
    if (!pinnedRef.current) event.preventDefault();
  }, []);

  return {
    open,
    onOpenChange,
    triggerProps: {
      onPointerDown: onTriggerPointerDown,
      onMouseEnter: openOnHover,
      onMouseLeave: scheduleClose,
    },
    contentProps: {
      onMouseEnter: cancelClose,
      onMouseLeave: scheduleClose,
      onOpenAutoFocus: onContentOpenAutoFocus,
    },
  };
}
