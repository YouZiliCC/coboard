import { useState } from 'react';
import { FolderPlus, MoreHorizontal, ShieldCheck, ShieldOff, UserCheck, UserX, Users as UsersIcon } from 'lucide-react';
import type { User, UserRole, UserWithProjects } from 'shared';
import {
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Spinner,
} from '../../components/ui';
import { isApiClientError } from '../../api/client';
import { useUpdateUser, useUsers } from '../../api/users';
import { useAuth } from '../../lib/auth-context';
import { avatarUrl, cn } from '../../lib/utils';
import { CreateUserDialog } from './CreateUserDialog';
import { AddUserToProjectsDialog } from './AddUserToProjectsDialog';
import { userRoleLabels } from './labels';

/**
 * Users management tab (§6.3, §7 GET/POST /users, PATCH /users/:id). Lists every
 * account and lets an admin create new ones, switch a user between admin/member,
 * and activate/deactivate them. The server is the real authority (§6.3); the
 * front end guards self-demotion/self-deactivation as a UX safety net.
 */
export function UsersTab(): JSX.Element {
  const { user: currentUser } = useAuth();
  const { data: users, isLoading, isError, refetch } = useUsers();
  const updateUser = useUpdateUser();
  const [actionError, setActionError] = useState<string | null>(null);
  /** Id of the user whose row mutation is in flight (drives per-row spinner). */
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** User whose "加入项目" dialog is open. */
  const [addingTo, setAddingTo] = useState<UserWithProjects | null>(null);

  async function patchUser(
    id: string,
    input: Parameters<typeof updateUser.mutateAsync>[0]['input'],
  ): Promise<void> {
    setActionError(null);
    setPendingId(id);
    try {
      await updateUser.mutateAsync({ id, input });
    } catch (err) {
      setActionError(isApiClientError(err) ? err.message : '操作失败，请稍后重试');
    } finally {
      setPendingId(null);
    }
  }

  const toggleRole = (u: User): void => {
    const nextRole: UserRole = u.role === 'admin' ? 'member' : 'admin';
    void patchUser(u.id, { role: nextRole });
  };

  const toggleActive = (u: User): void => {
    void patchUser(u.id, { isActive: !u.isActive });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={UsersIcon}
        title="加载用户失败"
        description="请检查网络后重试。"
        action={
          <Button variant="outline" onClick={() => void refetch()}>
            重新加载
          </Button>
        }
      />
    );
  }

  const list = users ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">用户</h2>
          <p className="text-sm text-muted-foreground">
            共 {list.length} 个账号。管理员可创建账号、调整角色与启用状态。
          </p>
        </div>
        <CreateUserDialog />
      </div>

      {actionError && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {actionError}
        </p>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={UsersIcon}
          title="还没有账号"
          description="新建第一个团队成员账号吧。"
          action={<CreateUserDialog />}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2.5">成员</th>
                <th className="px-4 py-2.5">角色</th>
                <th className="px-4 py-2.5">状态</th>
                <th className="hidden px-4 py-2.5 md:table-cell">所属项目</th>
                <th className="hidden px-4 py-2.5 sm:table-cell">创建时间</th>
                <th className="px-4 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => {
                const isSelf = u.id === currentUser?.id;
                const rowPending = pendingId === u.id;
                return (
                  <tr
                    key={u.id}
                    className={cn(
                      'border-b border-border last:border-0 transition-colors hover:bg-accent/40',
                      !u.isActive && 'opacity-60',
                    )}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <Avatar
                          name={u.displayName}
                          color={u.avatarColor}
                          imageUrl={u.hasAvatar ? avatarUrl(u.id) : undefined}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 font-medium text-foreground">
                            <span className="truncate">{u.displayName}</span>
                            {isSelf && (
                              <span className="text-xs font-normal text-muted-foreground">（我）</span>
                            )}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={u.role === 'admin' ? 'primary' : 'neutral'}>
                        {userRoleLabels[u.role]}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      {u.isActive ? (
                        <Badge variant="success">已启用</Badge>
                      ) : (
                        <Badge variant="outline">已停用</Badge>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 md:table-cell">
                      {u.projects.length === 0 ? (
                        <Badge variant="warning">未加入任何项目</Badge>
                      ) : (
                        <div className="flex max-w-[18rem] flex-wrap gap-1">
                          {u.projects.map((p) => (
                            <Badge
                              key={p.projectId}
                              variant={p.role === 'lead' ? 'primary' : 'neutral'}
                            >
                              {p.projectName}
                              {p.role === 'lead' && ' · 负责人'}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {formatDate(u.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`管理 ${u.displayName}`}
                            loading={rowPending}
                          >
                            {!rowPending && <MoreHorizontal className="h-4 w-4" aria-hidden />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownMenuItem onSelect={() => setAddingTo(u)}>
                            <FolderPlus className="h-4 w-4" aria-hidden />
                            加入项目
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => toggleRole(u)}
                            disabled={isSelf}
                          >
                            {u.role === 'admin' ? (
                              <>
                                <ShieldOff className="h-4 w-4" aria-hidden />
                                降为成员
                              </>
                            ) : (
                              <>
                                <ShieldCheck className="h-4 w-4" aria-hidden />
                                设为管理员
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onSelect={() => toggleActive(u)}
                            disabled={isSelf}
                            destructive={u.isActive}
                          >
                            {u.isActive ? (
                              <>
                                <UserX className="h-4 w-4" aria-hidden />
                                停用账号
                              </>
                            ) : (
                              <>
                                <UserCheck className="h-4 w-4" aria-hidden />
                                启用账号
                              </>
                            )}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {addingTo && (
        <AddUserToProjectsDialog
          user={addingTo}
          open={addingTo !== null}
          onOpenChange={(next) => {
            if (!next) setAddingTo(null);
          }}
        />
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
