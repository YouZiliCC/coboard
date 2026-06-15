import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { FolderKanban, Users } from 'lucide-react';
import { useAuth } from '../lib/auth-context';
import { cn } from '../lib/utils';
import { ProjectsTab, UsersTab } from '../features/admin';

/**
 * Admin console (§6.3). Two tabs — Users and Projects — for managing accounts and
 * projects/members. Access is admin-only: the router already wraps this route in
 * `RequireAdmin`, and the server enforces the real authorization on every write
 * (§6.3); the guard below is a defensive belt-and-braces redirect.
 */

type AdminTab = 'users' | 'projects';

interface TabDef {
  id: AdminTab;
  label: string;
  icon: typeof Users;
}

const tabs: readonly TabDef[] = [
  { id: 'users', label: '用户', icon: Users },
  { id: 'projects', label: '项目', icon: FolderKanban },
];

export default function AdminPage(): JSX.Element {
  const { isAdmin } = useAuth();
  const [active, setActive] = useState<AdminTab>('users');

  // Defensive client-side gate (the route is already admin-guarded).
  if (!isAdmin) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <header className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight">后台管理</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理团队的用户账号与项目设置。</p>
        </header>

        {/* Onboarding guidance: the 3-step org model. Coboard has no separate
            "user group" concept — a project IS the group. Make that explicit so
            admins don't create accounts that can't see any board. */}
        <section
          aria-label="使用指引"
          className="mb-6 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5"
        >
          <h2 className="mb-3 text-sm font-semibold text-foreground">团队协作三步走</h2>
          <ol className="flex flex-col gap-3 sm:flex-row sm:gap-4">
            {[
              { n: 1, t: '建账号', d: '在「用户」里为每位成员创建登录账号' },
              { n: 2, t: '建项目', d: '在「项目」里创建项目 —— 项目就是你的团队/小组' },
              { n: 3, t: '加成员', d: '进入项目点「成员」，把人加进去并设角色（负责人 / 成员）' },
            ].map((s) => (
              <li key={s.n} className="flex flex-1 items-start gap-2.5">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                  {s.n}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{s.t}</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">{s.d}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-3 border-t border-primary/15 pt-3 text-xs text-muted-foreground">
            💡 Coboard 没有单独的「用户组」——<strong className="font-medium text-foreground">项目即分组</strong>。
            成员只有被加入项目后，才能看到对应的看板。
          </p>
        </section>

        <div
          role="tablist"
          aria-label="管理分区"
          className="mb-6 inline-flex items-center gap-1 rounded-lg border border-border bg-secondary/40 p-1"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const selected = active === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActive(tab.id)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4" aria-hidden />
                {tab.label}
              </button>
            );
          })}
        </div>

        {active === 'users' ? <UsersTab /> : <ProjectsTab />}
      </div>
    </div>
  );
}
