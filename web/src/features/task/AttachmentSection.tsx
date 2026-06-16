import { useRef, useState } from 'react';
import { Download, Paperclip, Trash2, Upload } from 'lucide-react';
import type { Task, TaskFile } from 'shared';
import { Button, Spinner } from '../../components/ui';
import { isApiClientError } from '../../api/client';
import {
  MAX_TASK_FILE_BYTES,
  taskFileUrl,
  useDeleteTaskFile,
  useTaskFiles,
  useUploadTaskFile,
} from '../../api/task-files';
import type { TaskPermissionContext } from '../board/permissions';
import { isManager } from '../board/permissions';

/**
 * Attachment section (§7.2) inside the task detail drawer — "用于交付一些文件内容".
 * An 上传文件 button (a hidden file input guarded client-side at ≤5MB before upload),
 * plus the file list (filename, human-readable size, uploader) with a 下载 link and a
 * 删除 action visible to the uploader or a project lead/admin. The server re-enforces
 * the cap + the delete permission.
 */

export interface AttachmentSectionProps {
  task: Task;
  permCtx: TaskPermissionContext;
}

/** Format a byte count into a compact human-readable size ("12.3 KB" / "1.2 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

export function AttachmentSection({ task, permCtx }: AttachmentSectionProps): JSX.Element {
  const taskId = task.id;
  const { data: files, isLoading } = useTaskFiles(taskId);
  const uploadFile = useUploadTaskFile(taskId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const manager = isManager(permCtx, task);
  const myId = permCtx.user?.id;

  function handlePick(e: React.ChangeEvent<HTMLInputElement>): void {
    setError(null);
    const file = e.target.files?.[0];
    // Allow re-selecting the same file later by clearing the input value.
    e.target.value = '';
    if (!file) return;

    if (file.size > MAX_TASK_FILE_BYTES) {
      setError('文件过大，单个文件不能超过 5MB');
      return;
    }
    if (file.size === 0) {
      setError('文件为空');
      return;
    }

    uploadFile.mutate(file, {
      onError: (err) =>
        setError(isApiClientError(err) ? err.message : '上传失败，请稍后重试'),
    });
  }

  return (
    <div className="grid gap-2 rounded-lg border border-border bg-secondary/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          附件（用于交付文件内容，单个 ≤ 5MB）
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={uploadFile.isPending}
          onClick={() => inputRef.current?.click()}
        >
          {!uploadFile.isPending && <Upload className="h-3.5 w-3.5" aria-hidden />}
          上传文件
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          aria-hidden
          onChange={handlePick}
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      {isLoading ? (
        <div className="py-2 text-center">
          <Spinner label="加载附件" />
        </div>
      ) : !files || files.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">暂无附件</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {files.map((file) => (
            <FileRow
              key={file.id}
              taskId={taskId}
              file={file}
              canDelete={manager || file.uploaderId === myId}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FileRow({
  taskId,
  file,
  canDelete,
}: {
  taskId: string;
  file: TaskFile;
  canDelete: boolean;
}): JSX.Element {
  const deleteFile = useDeleteTaskFile(taskId);

  return (
    <li className="flex items-center gap-2 py-2">
      <Paperclip className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground" title={file.filename}>
          {file.filename}
        </p>
        <p className="text-xs text-muted-foreground">{formatFileSize(file.sizeBytes)}</p>
      </div>
      <a
        href={taskFileUrl(taskId, file.id)}
        download={file.filename}
        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        aria-label={`下载 ${file.filename}`}
      >
        <Download className="h-3.5 w-3.5" aria-hidden />
        下载
      </a>
      {canDelete && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
          aria-label={`删除 ${file.filename}`}
          loading={deleteFile.isPending}
          onClick={() => {
            if (window.confirm(`确定删除附件「${file.filename}」？`)) {
              deleteFile.mutate(file.id);
            }
          }}
        >
          {!deleteFile.isPending && <Trash2 className="h-3.5 w-3.5" aria-hidden />}
        </Button>
      )}
    </li>
  );
}
