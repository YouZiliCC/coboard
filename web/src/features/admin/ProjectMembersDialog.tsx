import { useMemo, useState } from 'react';
import { Trash2, UserPlus } from 'lucide-react';
import type { Project, ProjectRole } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  useAddProjectMember,
  useProjectMembers,
  useRemoveProjectMember,
} from '../../api/projects';
import { useUsers } from '../../api/users';
import { useAuth } from '../../lib/auth-context';
import { avatarUrl } from '../../lib/utils';
import { projectRoleLabels } from './labels';

/**
 * Manage-members dialog (§6.3, §7 GET/POST /projects/:id/members, DELETE
 * /projects/:id/members/:userId). An admin can add active users to the project,
 * set each member's lead/member role, and remove members. Adding an existing
 * member with a new role updates that role (server upserts on (project,user)).
 */
export function ProjectMembersDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>管理成员 · {project.name}</DialogTitle>
          <DialogDescription>添加成员、设置负责人/成员角色或移除成员。</DialogDescription>
        </DialogHeader>
        {open && <MembersBody project={project} />}
      </DialogContent>
    </Dialog>
  );
}

function MembersBody({ project }: { project: Project }): JSX.Element {
  const { user: currentUser } = useAuth();
  const membersQuery = useProjectMembers(project.id);
  const usersQuery = useUsers();
  const addMember = useAddProjectMember();
  const removeMember = useRemoveProjectMember();

  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [newRole, setNewRole] = useState<ProjectRole>('member');
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const members = membersQuery.data ?? [];

  // Active users that are not yet members — candidates for the "add" picker.
  const candidates = useMemo(() => {
    const memberIds = new Set(members.map((m) => m.userId));
    return (usersQuery.data ?? []).filter((u) => u.isActive && !memberIds.has(u.id));
  }, [members, usersQuery.data]);

  async function handleAdd(): Promise<void> {
    if (!selectedUserId) return;
    setError(null);
    setPendingUserId(selectedUserId);
    try {
      await addMember.mutateAsync({
        projectId: project.id,
        input: { userId: selectedUserId, role: newRole },
      });
      setSelectedUserId('');
      setNewRole('member');
    } catch (err) {
      setError(isApiClientError(err) ? err.message : '添加失败，请稍后重试');
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleChangeRole(userId: string, role: ProjectRole): Promise<void> {
    setError(null);
    setPendingUserId(userId);
    try {
      // POST upserts the (project, user) membership with the new role.
      await addMember.mutateAsync({ projectId: project.id, input: { userId, role } });
    } catch (err) {
      setError(isApiClientError(err) ? err.message : '修改角色失败，请稍后重试');
    } finally {
      setPendingUserId(null);
    }
  }

  async function handleRemove(userId: string): Promise<void> {
    setError(null);
    setPendingUserId(userId);
    try {
      await removeMember.mutateAsync({ projectId: project.id, userId });
    } catch (err) {
      setError(isApiClientError(err) ? err.message : '移除失败，请稍后重试');
    } finally {
      setPendingUserId(null);
    }
  }

  const loading = membersQuery.isLoading || usersQuery.isLoading;

  return (
    <div className="space-y-4">
      {/* Add member row — stacks on phones, inline on sm+ */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-secondary/30 p-3 sm:flex-row sm:items-end">
        <div className="grid flex-1 gap-1.5">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="add-member-user">
            添加成员
          </label>
          <Select value={selectedUserId} onValueChange={setSelectedUserId}>
            <SelectTrigger id="add-member-user" disabled={candidates.length === 0}>
              <SelectValue placeholder={candidates.length === 0 ? '没有可添加的用户' : '选择用户'} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.displayName}（{u.email}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5 sm:w-28">
          <label className="text-xs font-medium text-muted-foreground" htmlFor="add-member-role">
            角色
          </label>
          <Select value={newRole} onValueChange={(v) => setNewRole(v as ProjectRole)}>
            <SelectTrigger id="add-member-role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">{projectRoleLabels.member}</SelectItem>
              <SelectItem value="lead">{projectRoleLabels.lead}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          onClick={() => void handleAdd()}
          disabled={!selectedUserId}
          loading={pendingUserId !== null && pendingUserId === selectedUserId}
        >
          <UserPlus className="h-4 w-4" aria-hidden />
          添加
        </Button>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
      )}

      {/* Member list */}
      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Spinner />
        </div>
      ) : members.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
          该项目还没有成员。
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {members.map((m) => {
            const isSelf = m.userId === currentUser?.id;
            const rowPending = pendingUserId === m.userId;
            return (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2.5">
                <Avatar
                  name={m.user.displayName}
                  color={m.user.avatarColor}
                  imageUrl={m.user.hasAvatar ? avatarUrl(m.user.id) : undefined}
                  size="sm"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <span className="truncate">{m.user.displayName}</span>
                    {isSelf && <span className="text-xs font-normal text-muted-foreground">（我）</span>}
                    {m.user.role === 'admin' && (
                      <Badge variant="primary" className="ml-1">
                        管理员
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{m.user.email}</div>
                </div>
                <Select
                  value={m.role}
                  onValueChange={(v) => void handleChangeRole(m.userId, v as ProjectRole)}
                  disabled={rowPending}
                >
                  <SelectTrigger className="h-8 w-24" aria-label={`${m.user.displayName} 的角色`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{projectRoleLabels.member}</SelectItem>
                    <SelectItem value="lead">{projectRoleLabels.lead}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`移除 ${m.user.displayName}`}
                  loading={rowPending}
                  onClick={() => void handleRemove(m.userId)}
                >
                  {!rowPending && <Trash2 className="h-4 w-4 text-destructive" aria-hidden />}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
