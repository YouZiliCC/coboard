import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Plus } from 'lucide-react';
import { createTaskInputSchema, type CreateTaskInput, type Priority } from 'shared';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '../../components/ui';
import { isApiClientError } from '../../api/client';
import { useProjects } from '../../api/projects';
import { ALL_PROJECTS, useCreateTask, useProjectMembers } from '../../api/tasks';
import { LabelPicker } from './LabelPicker';
import { PRIORITY_LABELS } from './labels';

/**
 * Create-task dialog (§6.1, §8). A 项目 select at the top chooses the owning project
 * (the caller's visible projects) or 「不指定项目（任务池）」 for a no-project / pool
 * task. New tasks default to the `open` column; supplying an assignee dispatches the
 * task into `in_progress` server-side (§6.2) — assignment is only available for a
 * project task (a pool task has no members). Validated against the shared
 * {@link createTaskInputSchema} and submitted via the unified POST /tasks.
 */
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'urgent'];
const UNASSIGNED = '__unassigned__';
/** Sentinel select value for the 「不指定项目（任务池）」 option (§8). */
const NO_PROJECT = '__no_project__';

interface FormValues {
  title: string;
  description: string;
  priority: Priority;
  points: string;
  /** Claim-count lower bound (>= 1); below it the task waits in 待认领. */
  minClaimants: string;
  /** Claim-count upper bound; empty = unlimited. */
  maxClaimants: string;
  dueDate: string;
  assigneeId: string;
}

export interface CreateTaskDialogProps {
  /**
   * The current board's project. A concrete project id preselects it; the
   * all-projects sentinel ({@link ALL_PROJECTS}) or undefined defaults the select
   * to 「不指定项目（任务池）」 (§8).
   */
  projectId: string | undefined;
}

export function CreateTaskDialog({ projectId }: CreateTaskDialogProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const { data: projects } = useProjects();

  // Default the project select: a concrete board project preselects it; the
  // 全部项目 view (projectId === 'all') or no board defaults to the task pool (§8).
  const defaultProject =
    projectId && projectId !== ALL_PROJECTS ? projectId : NO_PROJECT;
  const [selectedProject, setSelectedProject] = useState<string>(defaultProject);
  // Selected label ids (task-labels) — kept outside react-hook-form (array state).
  const [labelIds, setLabelIds] = useState<string[]>([]);

  const createTask = useCreateTask();
  // Members for the assignee picker come from the chosen project; a pool task has
  // none, so the query stays disabled (§8).
  const projectForMembers =
    open && selectedProject !== NO_PROJECT ? selectedProject : undefined;
  const { data: members } = useProjectMembers(projectForMembers);

  const visibleProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archived),
    [projects],
  );

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    defaultValues: {
      title: '',
      description: '',
      priority: 'medium',
      points: '',
      minClaimants: '1',
      maxClaimants: '',
      dueDate: '',
      assigneeId: UNASSIGNED,
    },
  });

  const priority = watch('priority');
  const assigneeId = watch('assigneeId');
  const isPoolTask = selectedProject === NO_PROJECT;

  // Reset the whole dialog (form + project select) to its opening defaults.
  function resetDialog(): void {
    reset();
    setSelectedProject(defaultProject);
    setLabelIds([]);
  }

  const onSubmit = handleSubmit((values) => {
    // Build the API payload, normalizing optional/empty fields.
    // Claim limits (claim-limits): min defaults to 1; an invalid/garbage value is
    // passed through so the shared schema reports it. Max omitted = unlimited.
    const min = values.minClaimants.trim() === '' ? 1 : Number(values.minClaimants);
    const payload: CreateTaskInput = {
      title: values.title.trim(),
      priority: values.priority,
      minClaimants: min,
    };
    if (values.description.trim()) payload.description = values.description.trim();
    if (values.points.trim()) {
      const pts = Number(values.points);
      if (Number.isInteger(pts) && pts >= 0) payload.points = pts;
    }
    if (values.maxClaimants.trim()) {
      payload.maxClaimants = Number(values.maxClaimants);
    }
    if (values.dueDate) payload.dueDate = values.dueDate;
    if (labelIds.length > 0) payload.labelIds = labelIds;
    // A pool task carries no project and cannot be assigned at creation.
    if (!isPoolTask) {
      payload.projectId = selectedProject;
      if (values.assigneeId !== UNASSIGNED) payload.assigneeId = values.assigneeId;
    }

    // Validate against the shared contract before sending.
    const parsed = createTaskInputSchema.safeParse(payload);
    if (!parsed.success) {
      const titleIssue = parsed.error.issues.find((iss) => iss.path[0] === 'title');
      if (titleIssue) setError('title', { message: titleIssue.message });
      const minIssue = parsed.error.issues.find((iss) => iss.path[0] === 'minClaimants');
      if (minIssue) setError('minClaimants', { message: minIssue.message });
      const maxIssue = parsed.error.issues.find((iss) => iss.path[0] === 'maxClaimants');
      if (maxIssue) setError('maxClaimants', { message: maxIssue.message });
      return;
    }

    createTask.mutate(parsed.data, {
      onSuccess: () => {
        resetDialog();
        setOpen(false);
      },
      onError: (err) => {
        if (isApiClientError(err) && err.fields?.['title']?.[0]) {
          setError('title', { message: err.fields['title'][0] });
        }
      },
    });
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) resetDialog();
      }}
    >
      <DialogTrigger asChild>
        <Button size="md">
          <Plus className="h-4 w-4" aria-hidden />
          新建任务
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>
            创建后默认进入「待认领」；如直接指派负责人，将进入「进行中」。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-1.5">
            <Label>所属项目</Label>
            <Select
              value={selectedProject}
              onValueChange={(v) => {
                setSelectedProject(v);
                // Switching projects invalidates any previously chosen member.
                setValue('assigneeId', UNASSIGNED);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_PROJECT}>不指定项目（任务池）</SelectItem>
                {visibleProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="task-title" required>
              标题
            </Label>
            <Input
              id="task-title"
              autoFocus
              placeholder="简要描述这个任务"
              invalid={!!errors.title}
              {...register('title', { required: '标题不能为空' })}
            />
            {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="task-desc">描述（支持 Markdown）</Label>
            <Textarea
              id="task-desc"
              rows={4}
              placeholder="补充背景、验收标准等"
              {...register('description')}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>优先级</Label>
              <Select value={priority} onValueChange={(v) => setValue('priority', v as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="task-points">点数（选填）</Label>
              <Input
                id="task-points"
                type="number"
                min={0}
                inputMode="numeric"
                placeholder="如 3"
                {...register('points')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="task-min-claimants">认领人数下限</Label>
              <Input
                id="task-min-claimants"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="默认 1"
                invalid={!!errors.minClaimants}
                {...register('minClaimants')}
              />
              <p className="text-xs text-muted-foreground">达到该人数才进入「进行中」，否则停留在「待认领」。</p>
              {errors.minClaimants && (
                <p className="text-xs text-destructive">{errors.minClaimants.message}</p>
              )}
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="task-max-claimants">认领人数上限（选填）</Label>
              <Input
                id="task-max-claimants"
                type="number"
                min={1}
                inputMode="numeric"
                placeholder="留空＝不限"
                invalid={!!errors.maxClaimants}
                {...register('maxClaimants')}
              />
              <p className="text-xs text-muted-foreground">达到上限后不再接受新的认领。</p>
              {errors.maxClaimants && (
                <p className="text-xs text-destructive">{errors.maxClaimants.message}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="task-due">截止日期（选填）</Label>
              <Input id="task-due" type="date" {...register('dueDate')} />
            </div>

            {/* Assignment requires a project (pool tasks have no members, §8). */}
            {!isPoolTask && (
              <div className="grid gap-1.5">
                <Label>负责人（选填）</Label>
                <Select value={assigneeId} onValueChange={(v) => setValue('assigneeId', v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="不指派" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>不指派</SelectItem>
                    {(members ?? []).map((m) => (
                      <SelectItem key={m.userId} value={m.userId}>
                        {m.user.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>标签（选填）</Label>
            <LabelPicker value={labelIds} onChange={setLabelIds} />
          </div>

          {isPoolTask && (
            <p className="text-xs text-muted-foreground">
              任务池任务对所有成员可见，需自行认领，创建时无法指派负责人。
            </p>
          )}

          {createTask.isError && !errors.title && (
            <p className="text-xs text-destructive">
              {isApiClientError(createTask.error)
                ? createTask.error.message
                : '创建失败，请稍后重试'}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                resetDialog();
                setOpen(false);
              }}
            >
              取消
            </Button>
            <Button type="submit" loading={createTask.isPending}>
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
