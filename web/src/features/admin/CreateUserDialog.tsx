import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UserPlus } from 'lucide-react';
import { createUserInputSchema, type CreateUserInput } from 'shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui';
import { isApiClientError, type FieldErrors } from '../../api/client';
import { useCreateUser } from '../../api/users';
import { cn } from '../../lib/utils';
import { avatarColorPalette, pickAvatarColor, userRoleLabels } from './labels';

/**
 * Create-account dialog (§6.3, §7 POST /users). An admin sets the email, an
 * initial password (the member can change it later, §8), a display name, a global
 * role, and an avatar color. Validates with the shared `createUserInputSchema`.
 */
export function CreateUserDialog(): JSX.Element {
  const [open, setOpen] = useState(false);
  const createUser = useCreateUser();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    watch,
    formState: { errors },
  } = useForm<CreateUserInput>({
    resolver: zodResolver(createUserInputSchema),
    defaultValues: {
      email: '',
      password: '',
      displayName: '',
      role: 'member',
      avatarColor: avatarColorPalette[0],
    },
  });

  const role = watch('role');
  const avatarColor = watch('avatarColor');

  // Reset the form each time the dialog opens fresh.
  useEffect(() => {
    if (open) {
      reset({
        email: '',
        password: '',
        displayName: '',
        role: 'member',
        avatarColor: avatarColorPalette[0],
      });
      setFormError(null);
    }
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await createUser.mutateAsync(values);
      setOpen(false);
    } catch (err) {
      if (isApiClientError(err)) {
        if (err.fields) {
          applyFieldErrors(err.fields);
        }
        // 409 = email already taken — surface on the email field.
        if (err.isConflict) {
          setError('email', { type: 'server', message: '该邮箱已被使用' });
        } else if (!err.fields) {
          setFormError(err.message);
        }
      } else {
        setFormError('创建失败，请稍后重试');
      }
    }
  });

  function applyFieldErrors(fields: FieldErrors): void {
    for (const [path, messages] of Object.entries(fields)) {
      const field = path.split('.')[0] as keyof CreateUserInput;
      if (messages[0]) {
        setError(field, { type: 'server', message: messages[0] });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} size="sm">
        <UserPlus className="h-4 w-4" aria-hidden />
        新建账号
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建账号</DialogTitle>
          <DialogDescription>
            为团队成员创建账号并设置初始密码，成员登录后可自行修改密码。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="new-user-email" required>
              邮箱
            </Label>
            <Input
              id="new-user-email"
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
              invalid={Boolean(errors.email)}
              {...register('email', {
                onBlur: (e) => {
                  // Suggest a stable avatar color from the email if none chosen yet.
                  const value = (e.target as HTMLInputElement).value.trim();
                  if (value && !avatarColor) {
                    setValue('avatarColor', pickAvatarColor(value));
                  }
                },
              })}
            />
            {errors.email && (
              <p className="text-xs text-destructive">{errors.email.message}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-user-name" required>
              昵称
            </Label>
            <Input
              id="new-user-name"
              autoComplete="off"
              placeholder="如：张三"
              invalid={Boolean(errors.displayName)}
              {...register('displayName')}
            />
            {errors.displayName && (
              <p className="text-xs text-destructive">{errors.displayName.message}</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-user-password" required>
              初始密码
            </Label>
            <Input
              id="new-user-password"
              type="text"
              autoComplete="off"
              placeholder="至少 8 位"
              invalid={Boolean(errors.password)}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-xs text-destructive">{errors.password.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                请记录并安全地告知成员，登录后可自行修改。
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>角色</Label>
            <Select value={role} onValueChange={(v) => setValue('role', v as CreateUserInput['role'])}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{userRoleLabels.member}</SelectItem>
                <SelectItem value="admin">{userRoleLabels.admin}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              管理员可管理用户与项目；成员仅参与项目协作。
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>头像颜色</Label>
            <div className="flex flex-wrap gap-2">
              {avatarColorPalette.map((color) => {
                const selected = avatarColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setValue('avatarColor', color)}
                    aria-label={`选择颜色 ${color}`}
                    aria-pressed={selected}
                    className={cn(
                      'h-7 w-7 rounded-full ring-offset-2 ring-offset-background transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      selected ? 'ring-2 ring-ring scale-110' : 'hover:scale-105',
                    )}
                    style={{ backgroundColor: color }}
                  />
                );
              })}
            </div>
          </div>

          {formError && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button type="submit" loading={createUser.isPending}>
              创建账号
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
