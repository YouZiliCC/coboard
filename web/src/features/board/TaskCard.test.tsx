import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TaskClaimant, User, Task } from 'shared';
import { TaskCard } from './TaskCard';
import type { TaskPermissionContext } from './permissions';

/**
 * TaskCard rendering tests (§10 — 前端关键组件 RTL; lifecycle v2). Verifies the
 * card surfaces title, points, priority, due date, and stacked claimant avatars,
 * and that the claim affordance appears for a task the current user hasn't claimed.
 */

const mockUser: User = {
  id: 'user-1',
  email: 'me@example.com',
  displayName: '张三',
  avatarColor: '#3b82f6',
  role: 'member',
  isActive: true,
  hasAvatar: false,
  createdAt: '2026-06-01T00:00:00.000Z',
};

vi.mock('../../lib/auth-context', () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    isAuthenticated: true,
    isAdmin: false,
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

const claimMutate = vi.fn();
const deliverMutate = vi.fn();
const reviewMutate = vi.fn();
vi.mock('../../api/tasks', () => ({
  useClaimTask: () => ({ mutate: claimMutate, isPending: false }),
  useDeliverTask: () => ({ mutate: deliverMutate, isPending: false, isError: false }),
  useReviewTask: () => ({ mutate: reviewMutate, isPending: false, isError: false }),
}));

const permCtx: TaskPermissionContext = { user: mockUser, projectRole: 'member' };

function makeClaimant(overrides: Partial<TaskClaimant> & Pick<TaskClaimant, 'userId' | 'displayName'>): TaskClaimant {
  return {
    avatarColor: '#3b82f6',
    hasAvatar: false,
    points: null,
    claimedAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    projectName: '示例项目',
    projectKey: 'DEMO',
    title: '完成登录页面',
    description: null,
    status: 'open',
    points: 5,
    priority: 'high',
    dueDate: '2026-06-20',
    createdBy: 'user-1',
    rank: 'm',
    completedAt: null,
    deliveredAt: null,
    deliveredBy: null,
    reviewedBy: null,
    claimants: [],
    labels: [],
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskCard', () => {
  beforeEach(() => {
    claimMutate.mockReset();
  });

  it('renders the title, points badge, priority, and due date', () => {
    render(<TaskCard task={makeTask()} projectId="project-1" permCtx={permCtx} />);

    expect(screen.getByText('完成登录页面')).toBeTruthy();
    expect(screen.getByText('5 点')).toBeTruthy();
    expect(screen.getByText('高')).toBeTruthy();
    expect(screen.getByText('06-20')).toBeTruthy();
  });

  it('shows the claim button for a task the user has not claimed', () => {
    render(<TaskCard task={makeTask()} projectId="project-1" permCtx={permCtx} />);
    expect(screen.getByRole('button', { name: '认领任务' })).toBeTruthy();
  });

  it('shows stacked claimant avatars and hides claim once the user has claimed', () => {
    const task = makeTask({
      status: 'in_progress',
      claimants: [
        makeClaimant({ userId: 'user-1', displayName: '张三' }),
        makeClaimant({ userId: 'user-2', displayName: '李四' }),
      ],
    });
    render(<TaskCard task={task} projectId="project-1" permCtx={permCtx} />);

    // The current user (user-1) is already a claimant → no claim button.
    expect(screen.queryByRole('button', { name: '认领任务' })).toBeNull();
    // Both claimants' names appear (Avatar sr-only label).
    expect(screen.getAllByText('张三').length).toBeGreaterThan(0);
    expect(screen.getAllByText('李四').length).toBeGreaterThan(0);
  });

  it('shows a 待审阅 badge for a non-lead on a pending_review task', () => {
    const task = makeTask({
      status: 'pending_review',
      claimants: [makeClaimant({ userId: 'user-2', displayName: '李四' })],
    });
    render(<TaskCard task={task} projectId="project-1" permCtx={permCtx} />);
    expect(screen.getByText('待审阅')).toBeTruthy();
  });

  it('omits the points badge when points are null', () => {
    render(<TaskCard task={makeTask({ points: null })} projectId="project-1" permCtx={permCtx} />);
    expect(screen.queryByText(/点$/)).toBeNull();
  });

  it('shows the project badge only in all-projects mode (§8)', () => {
    const { rerender } = render(
      <TaskCard task={makeTask()} projectId="project-1" permCtx={permCtx} />,
    );
    // Default (per-project board): no project badge.
    expect(screen.queryByText('示例项目')).toBeNull();

    rerender(
      <TaskCard task={makeTask()} projectId="all" permCtx={permCtx} showProjectBadge />,
    );
    expect(screen.getByText('示例项目')).toBeTruthy();
  });

  it('labels a no-project (pool) task 无项目 when showing the badge (§8)', () => {
    render(
      <TaskCard
        task={makeTask({ projectId: null, projectName: null, projectKey: null })}
        projectId="all"
        permCtx={permCtx}
        showProjectBadge
      />,
    );
    expect(screen.getByText('无项目')).toBeTruthy();
  });
});
