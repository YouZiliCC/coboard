import { useNavigate, useParams } from 'react-router-dom';
import { ChevronsUpDown, FolderKanban, LayoutGrid } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui';
import { useProjects } from '../../api/projects';
import { ALL_PROJECTS } from '../../api/tasks';
import { cn } from '../../lib/utils';

/**
 * Project switcher (§4, §8). Lists the current user's visible projects (useProjects)
 * plus a 「全部项目」 entry that opens the aggregated board (`/board/all`). Navigates
 * to a project's board on selection and reflects the active project — or the
 * all-projects mode — from the `/board/:projectId` route param.
 */
export function ProjectSwitcher(): JSX.Element {
  const navigate = useNavigate();
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading } = useProjects();

  const isAll = projectId === ALL_PROJECTS;
  const active = projects?.find((p) => p.id === projectId);
  const visibleProjects = projects?.filter((p) => !p.archived) ?? [];

  const label = isAll
    ? '全部项目'
    : isLoading
      ? '加载项目…'
      : (active?.name ?? '选择项目');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            // Constrain tightly on phones so the nav bar never overflows; the label
            // truncates. sm+ allows a more generous width.
            'inline-flex h-9 min-w-0 max-w-[9rem] items-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium transition-colors sm:max-w-[16rem]',
            'hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
          aria-label="切换项目"
        >
          {isAll ? (
            <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          ) : (
            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="truncate">{label}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[14rem]">
        <DropdownMenuLabel>项目</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => navigate(`/board/${ALL_PROJECTS}`)}
          className={cn(isAll && 'bg-accent text-accent-foreground')}
        >
          <LayoutGrid className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">全部项目</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {visibleProjects.length === 0 ? (
          <DropdownMenuItem disabled>暂无可见项目</DropdownMenuItem>
        ) : (
          visibleProjects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => navigate(`/board/${project.id}`)}
              className={cn(project.id === projectId && 'bg-accent text-accent-foreground')}
            >
              <span className="truncate">{project.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{project.key}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
