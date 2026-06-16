import { type ReactNode } from 'react';
import { TopNav } from './TopNav';

/**
 * Authenticated app shell (§4). Pinned to the viewport with `fixed inset-0` so the
 * document itself can never scroll (no stray page-level scrollbar on any device);
 * only the inner page region scrolls. Persistent top nav above the page content.
 */
export function AppShell({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background">
      <TopNav />
      <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
    </div>
  );
}
