import { Link, NavLink, useMatch, useNavigate } from 'react-router-dom';
import { LayoutGrid, LogOut, BarChart3, Compass, Lightbulb, Settings, UserCog } from 'lucide-react';
import {
  Avatar,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui';
import { ProjectSwitcher } from './ProjectSwitcher';
import { useAuth } from '../../lib/auth-context';
import { avatarUrl, cn } from '../../lib/utils';
import { useHoverMenu } from '../../lib/use-hover-menu';

/**
 * Top navigation bar (§4). Logo, project switcher, primary nav (看板 / 统计 /
 * 管理 — 管理 admin-only), and the user menu with logout. Frontend role hiding is
 * a UX nicety; the server enforces real authorization (§6.3).
 */

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutGrid;
  adminOnly?: boolean;
}

export function TopNav(): JSX.Element {
  const { user, isAdmin, logout } = useAuth();
  const navigate = useNavigate();
  // The nav lives above the /board/:projectId route, so useParams can't see the
  // param — read it from the location. Default the 看板 link to the all view.
  const projectId = useMatch('/board/:projectId')?.params.projectId;
  const boardTarget = projectId ?? 'all';
  const userMenu = useHoverMenu();

  const navItems: NavItem[] = [
    {
      to: `/board/${boardTarget}`,
      label: '看板',
      icon: LayoutGrid,
    },
    { to: '/projects', label: '项目', icon: Compass },
    { to: '/ideas', label: '灵感', icon: Lightbulb },
    { to: '/stats', label: '统计', icon: BarChart3 },
    { to: '/admin', label: '管理', icon: Settings, adminOnly: true },
  ];

  const handleLogout = async (): Promise<void> => {
    await logout();
    // Full reload to /login guarantees a clean app boot (fresh, unauthenticated
    // state) regardless of any in-flight SPA state.
    window.location.assign('/login');
  };

  return (
    <header className="sticky top-0 z-30 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80">
      <div className="flex h-14 items-center gap-2 px-4 sm:gap-4 sm:px-6">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2" aria-label="Coboard 首页">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LayoutGrid className="h-4 w-4" aria-hidden />
          </span>
          <span className="hidden text-base font-semibold tracking-tight sm:inline">Coboard</span>
        </Link>

        <div className="h-5 w-px bg-border" aria-hidden />

        <ProjectSwitcher />

        {/* Primary nav */}
        <nav className="ml-2 hidden items-center gap-1 md:flex" aria-label="主导航">
          {navItems.map((item) => {
            if (item.adminOnly && !isAdmin) return null;
            const Icon = item.icon;
            return (
              <NavLink
                key={item.label}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-secondary text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )
                }
              >
                <Icon className="h-4 w-4" aria-hidden />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {user && (
            <DropdownMenu open={userMenu.open} onOpenChange={userMenu.onOpenChange} modal={false}>
              <DropdownMenuTrigger asChild {...userMenu.triggerProps}>
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-accent focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
                  aria-label="用户菜单"
                >
                  <Avatar
                    name={user.displayName}
                    color={user.avatarColor}
                    imageUrl={user.hasAvatar ? avatarUrl(user.id) : undefined}
                    size="sm"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent {...userMenu.contentProps}>
                <DropdownMenuLabel className="flex max-w-[16rem] flex-col gap-0.5">
                  <span className="truncate text-sm font-medium text-foreground">{user.displayName}</span>
                  <span className="truncate text-xs font-normal text-muted-foreground">
                    {user.email}
                  </span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {/* Mobile-friendly nav inside the menu. */}
                <div className="md:hidden">
                  {navItems.map((item) => {
                    if (item.adminOnly && !isAdmin) return null;
                    const Icon = item.icon;
                    return (
                      <DropdownMenuItem key={item.label} onSelect={() => navigate(item.to)}>
                        <Icon className="h-4 w-4" aria-hidden />
                        {item.label}
                      </DropdownMenuItem>
                    );
                  })}
                  <DropdownMenuSeparator />
                </div>
                <DropdownMenuItem onSelect={() => navigate('/account/profile')}>
                  <UserCog className="h-4 w-4" aria-hidden />
                  修改资料
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => void handleLogout()}>
                  <LogOut className="h-4 w-4" aria-hidden />
                  退出登录
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
    </header>
  );
}
