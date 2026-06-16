import { useEffect, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  createProjectInputSchema,
  updateProjectInputSchema,
  type CreateProjectInput,
  type Project,
  type UpdateProjectInput,
} from 'shared';
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
  Textarea,
} from '../../components/ui';
import { isApiClientError, type FieldErrors } from '../../api/client';
import { useCreateProject, useUpdateProject } from '../../api/projects';

/**
 * Create / edit project dialog (§6.3, §7 POST /projects, PATCH /projects/:id).
 *
 * - Create mode: collects name, key (immutable short identifier), description.
 * - Edit mode: name + description (the contract's `updateProjectInputSchema` has
 *   no `key`, so the key is shown read-only). Archive/restore is a separate
 *   one-click action on the card, not part of this form.
 */

interface CreateProps {
  mode: 'create';
  /** Custom trigger; defaults to a primary "新建项目" button. */
  trigger?: ReactNode;
  /** Called after a project is successfully created (e.g. to prompt adding members). */
  onCreated?: (project: Project) => void;
}

interface EditProps {
  mode: 'edit';
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ProjectFormDialogProps = CreateProps | EditProps;

export function ProjectFormDialog(props: ProjectFormDialogProps): JSX.Element {
  if (props.mode === 'edit') {
    return (
      <EditProjectDialog
        project={props.project}
        open={props.open}
        onOpenChange={props.onOpenChange}
      />
    );
  }
  return <CreateProjectDialog trigger={props.trigger} onCreated={props.onCreated} />;
}

function applyFieldErrors<T extends Record<string, unknown>>(
  fields: FieldErrors,
  setError: (name: keyof T & string, error: { type: string; message: string }) => void,
): void {
  for (const [path, messages] of Object.entries(fields)) {
    const field = path.split('.')[0] as keyof T & string;
    if (messages[0]) {
      setError(field, { type: 'server', message: messages[0] });
    }
  }
}

function CreateProjectDialog({
  trigger,
  onCreated,
}: {
  trigger?: ReactNode;
  onCreated?: (project: Project) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const createProject = useCreateProject();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<CreateProjectInput>({
    resolver: zodResolver(createProjectInputSchema),
    defaultValues: { name: '', key: '', description: '' },
  });

  useEffect(() => {
    if (open) {
      reset({ name: '', key: '', description: '' });
      setFormError(null);
    }
  }, [open, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    // Drop an empty optional description so it serializes cleanly.
    const payload: CreateProjectInput = {
      ...values,
      description: values.description?.trim() ? values.description.trim() : undefined,
    };
    try {
      const created = await createProject.mutateAsync(payload);
      setOpen(false);
      onCreated?.(created);
    } catch (err) {
      if (isApiClientError(err)) {
        if (err.fields) {
          applyFieldErrors<CreateProjectInput>(err.fields, setError);
        } else if (err.isConflict) {
          setError('key', { type: 'server', message: '该项目标识已被使用' });
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('创建失败，请稍后重试');
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ?? (
        <Button size="sm" onClick={() => setOpen(true)}>
          新建项目
        </Button>
      )}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>新建项目</DialogTitle>
          <DialogDescription>项目用于组织看板、任务与成员。标识创建后不可修改。</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="new-project-name" required>
              项目名称
            </Label>
            <Input
              id="new-project-name"
              placeholder="如：产品研发"
              invalid={Boolean(errors.name)}
              {...register('name')}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-project-key" required>
              项目标识
            </Label>
            <Input
              id="new-project-key"
              placeholder="如：PROD"
              autoCapitalize="characters"
              invalid={Boolean(errors.key)}
              {...register('key', {
                setValueAs: (v: string) => v.trim().toUpperCase(),
              })}
            />
            {errors.key ? (
              <p className="text-xs text-destructive">{errors.key.message}</p>
            ) : (
              <p className="text-xs text-muted-foreground">2-10 位大写字母或数字，用于标识项目。</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="new-project-desc">项目描述</Label>
            <Textarea
              id="new-project-desc"
              rows={3}
              placeholder="可选"
              invalid={Boolean(errors.description)}
              {...register('description')}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
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
            <Button type="submit" loading={createProject.isPending}>
              创建项目
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  const updateProject = useUpdateProject();
  const [formError, setFormError] = useState<string | null>(null);

  type EditValues = { name: string; description: string };

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<EditValues>({
    // Validate name + description against the shared update schema's field rules.
    resolver: zodResolver(
      updateProjectInputSchema.innerType().pick({ name: true, description: true }),
    ),
    defaultValues: { name: project.name, description: project.description ?? '' },
  });

  useEffect(() => {
    if (open) {
      reset({ name: project.name, description: project.description ?? '' });
      setFormError(null);
    }
  }, [open, project, reset]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    const input: UpdateProjectInput = {};
    const nextName = values.name.trim();
    if (nextName !== project.name) input.name = nextName;
    const nextDesc = values.description.trim() ? values.description.trim() : null;
    if (nextDesc !== (project.description ?? null)) input.description = nextDesc;

    // Nothing changed — just close (the API would reject an empty patch).
    if (Object.keys(input).length === 0) {
      onOpenChange(false);
      return;
    }
    try {
      await updateProject.mutateAsync({ id: project.id, input });
      onOpenChange(false);
    } catch (err) {
      if (isApiClientError(err)) {
        if (err.fields) {
          applyFieldErrors<EditValues>(err.fields, setError);
        } else {
          setFormError(err.message);
        }
      } else {
        setFormError('保存失败，请稍后重试');
      }
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>编辑项目</DialogTitle>
          <DialogDescription>
            标识 <span className="font-mono font-medium text-foreground">{project.key}</span> 创建后不可修改。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="grid gap-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="edit-project-name" required>
              项目名称
            </Label>
            <Input
              id="edit-project-name"
              invalid={Boolean(errors.name)}
              {...register('name')}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="edit-project-desc">项目描述</Label>
            <Textarea
              id="edit-project-desc"
              rows={3}
              placeholder="可选"
              invalid={Boolean(errors.description)}
              {...register('description')}
            />
            {errors.description && (
              <p className="text-xs text-destructive">{errors.description.message}</p>
            )}
          </div>

          {formError && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={updateProject.isPending}>
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
