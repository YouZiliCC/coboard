import { useMemo, useState } from 'react';
import { Check, FolderPlus } from 'lucide-react';
import type { ProjectRole, UserWithProjects } from 'shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '../../components/ui';
import { isApiClientError } from '../../api/client';
import { useAddProjectMember, useProjects } from '../../api/projects';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../lib/query';
import { cn } from '../../lib/utils';
import { projectRoleLabels } from './labels';

/**
 * Bulk "add a user to multiple projects" dialog (§6.3). Lets an admin enroll one
 * account into several projects at once (the user must be in a project to see any
 * board). Reuses POST /projects/:id/members per selected project.
 */
export function AddUserToProjectsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: UserWithProjects;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>把 {user.displayName} 加入项目</DialogTitle>
          <DialogDescription>勾选项目并选择角色，一次性把该成员加入多个项目。</DialogDescription>
        </DialogHeader>
        {open && <Body user={user} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function Body({
  user,
  onDone,
}: {
  user: UserWithProjects;
  onDone: () => void;
}): JSX.Element {
  const projectsQuery = useProjects();
  const addMember = useAddProjectMember();
  const queryClient = useQueryClient();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [role, setRole] = useState<ProjectRole>('member');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Active (non-archived) projects the user is NOT already a member of.
  const candidates = useMemo(() => {
    const already = new Set(user.projects.map((p) => p.projectId));
    return (projectsQuery.data ?? []).filter((p) => !p.archived && !already.has(p.id));
  }, [projectsQuery.data, user.projects]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleAdd(): Promise<void> {
    if (selected.size === 0) return;
    setError(null);
    setBusy(true);
    const ids = [...selected];
    const results = await Promise.allSettled(
      ids.map((projectId) =>
        addMember.mutateAsync({ projectId, input: { userId: user.id, role } }),
      ),
    );
    setBusy(false);
    const failed = results.filter((r) => r.status === 'rejected').length;
    // Refresh the users table so the new project chips appear.
    void queryClient.invalidateQueries({ queryKey: queryKeys.users() });
    if (failed > 0) {
      const first = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      const reason = first && isApiClientError(first.reason) ? first.reason.message : '部分项目添加失败';
      setError(`${ids.length - failed}/${ids.length} 已添加，${failed} 个失败：${reason}`);
      return;
    }
    onDone();
  }

  if (projectsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {candidates.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          该成员已加入所有可用项目，或暂无项目可加入。
        </p>
      ) : (
        <>
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">角色</span>
            <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{projectRoleLabels.member}</SelectItem>
                <SelectItem value="lead">{projectRoleLabels.lead}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ul className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-border p-1">
            {candidates.map((p) => {
              const checked = selected.has(p.id);
              return (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => toggle(p.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
                      checked ? 'bg-primary/10' : 'hover:bg-accent',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        checked ? 'border-primary bg-primary text-primary-foreground' : 'border-input',
                      )}
                    >
                      {checked && <Check className="h-3 w-3" aria-hidden />}
                    </span>
                    <span className="truncate font-medium text-foreground">{p.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
                      {p.key}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          取消
        </Button>
        <Button onClick={() => void handleAdd()} disabled={selected.size === 0} loading={busy}>
          <FolderPlus className="h-4 w-4" aria-hidden />
          加入所选（{selected.size}）
        </Button>
      </DialogFooter>
    </div>
  );
}
