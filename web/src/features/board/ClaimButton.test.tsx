import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaskClaimant, User, Task } from 'shared';
import { ClaimButton } from './ClaimButton';

/**
 * ClaimButton tests (§10 — 认领按钮; lifecycle v2). Verifies the button shows for a
 * claimable task the current user has not claimed, triggers the claim mutation on
 * click, and is hidden once the user is a claimant or the task left the claimable
 * states.
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
vi.mock('../../api/tasks', () => ({
  useClaimTask: () => ({ mutate: claimMutate, isPending: false }),
}));

function makeClaimant(userId: string, displayName: string): TaskClaimant {
  return {
    userId,
    displayName,
    avatarColor: '#3b82f6',
    hasAvatar: false,
    points: null,
    claimedAt: '2026-06-15T00:00:00.000Z',
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    projectName: '示例项目',
    projectKey: 'DEMO',
    title: '任务',
    description: null,
    status: 'open',
    points: null,
    priority: 'medium',
    minClaimants: 1,
    maxClaimants: null,
    dueDate: null,
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

describe('ClaimButton', () => {
  beforeEach(() => {
    claimMutate.mockReset();
  });

  it('renders for a claimable task the user has not claimed', () => {
    render(<ClaimButton task={makeTask()} projectId="project-1" />);
    expect(screen.getByRole('button', { name: '认领任务' })).toBeTruthy();
  });

  it('renders for an in_progress task the user has not claimed', () => {
    render(
      <ClaimButton
        task={makeTask({ status: 'in_progress', claimants: [makeClaimant('user-2', '李四')] })}
        projectId="project-1"
      />,
    );
    expect(screen.getByRole('button', { name: '认领任务' })).toBeTruthy();
  });

  it('calls the claim mutation with the task id on click', async () => {
    const user = userEvent.setup();
    render(<ClaimButton task={makeTask()} projectId="project-1" />);
    await user.click(screen.getByRole('button', { name: '认领任务' }));
    expect(claimMutate).toHaveBeenCalledTimes(1);
    expect(claimMutate.mock.calls[0]?.[0]).toBe('task-1');
  });

  it('renders nothing when the user is already a claimant', () => {
    const { container } = render(
      <ClaimButton
        task={makeTask({ status: 'in_progress', claimants: [makeClaimant('user-1', '张三')] })}
        projectId="project-1"
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a non-claimable (done) task', () => {
    const { container } = render(
      <ClaimButton task={makeTask({ status: 'done' })} projectId="project-1" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
