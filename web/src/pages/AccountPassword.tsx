import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, KeyRound, CheckCircle2 } from 'lucide-react';
import { passwordSchema } from 'shared';

import { api } from '../api/client';
import { isApiClientError } from '../api/client';
import { Button, Input, Label } from '../components/ui';

/**
 * Account self-service: change own password (§7 POST /auth/password).
 * The server verifies the current password, rotates all sessions, and mints a
 * fresh cookie for this device, so the user stays logged in after a change.
 */

const formSchema = z
  .object({
    currentPassword: z.string().min(1, '请输入当前密码'),
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, '请再次输入新密码'),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: '两次输入的新密码不一致',
    path: ['confirmPassword'],
  })
  .refine((d) => d.newPassword !== d.currentPassword, {
    message: '新密码不能与当前密码相同',
    path: ['newPassword'],
  });

type FormValues = z.infer<typeof formSchema>;

export default function AccountPasswordPage(): JSX.Element {
  const navigate = useNavigate();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  async function onSubmit(values: FormValues): Promise<void> {
    setSubmitError(null);
    try {
      await api.post('/auth/password', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
      setDone(true);
    } catch (err) {
      if (isApiClientError(err)) {
        // Wrong current password comes back as a 400/401 domain error.
        if (err.status === 400 || err.status === 401) {
          setError('currentPassword', { type: 'server', message: '当前密码不正确' });
          return;
        }
        if (err.fields?.newPassword?.[0]) {
          setError('newPassword', { type: 'server', message: err.fields.newPassword[0] });
          return;
        }
        setSubmitError(err.message);
        return;
      }
      setSubmitError('修改失败，请稍后重试');
    }
  }

  return (
    <div className="mx-auto w-full max-w-md px-4 py-8 sm:py-12">
      <button
        type="button"
        onClick={() => navigate(-1)}
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        返回
      </button>

      <div className="mb-6 flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <KeyRound className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">修改密码</h1>
          <p className="text-sm text-muted-foreground">定期更换密码以保护账号安全</p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        {done ? (
          <div className="flex flex-col items-center gap-4 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-emerald-500" aria-hidden />
            <div>
              <p className="font-medium text-foreground">密码已更新</p>
              <p className="mt-1 text-sm text-muted-foreground">
                下次登录请使用新密码
              </p>
            </div>
            <Button onClick={() => navigate('/')}>返回工作台</Button>
          </div>
        ) : (
          <form className="flex flex-col gap-5" onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="current-password" required>
                当前密码
              </Label>
              <Input
                id="current-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                invalid={Boolean(errors.currentPassword)}
                {...register('currentPassword')}
              />
              {errors.currentPassword && (
                <p className="text-xs text-destructive">{errors.currentPassword.message}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-password" required>
                新密码
              </Label>
              <Input
                id="new-password"
                type="password"
                autoComplete="new-password"
                placeholder="至少 8 位"
                invalid={Boolean(errors.newPassword)}
                {...register('newPassword')}
              />
              {errors.newPassword && (
                <p className="text-xs text-destructive">{errors.newPassword.message}</p>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="confirm-password" required>
                确认新密码
              </Label>
              <Input
                id="confirm-password"
                type="password"
                autoComplete="new-password"
                invalid={Boolean(errors.confirmPassword)}
                {...register('confirmPassword')}
              />
              {errors.confirmPassword && (
                <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
              )}
            </div>

            {submitError && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {submitError}
              </div>
            )}

            <Button type="submit" size="lg" className="mt-1 w-full" loading={isSubmitting}>
              {isSubmitting ? '正在更新…' : '更新密码'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
