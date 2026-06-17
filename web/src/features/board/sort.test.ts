import { describe, expect, it } from 'vitest';
import type { Priority, Task, TaskClaimant, TaskStatus } from 'shared';
import { compareTasksInColumn } from './sort';

/**
 * Column-aware task ordering (task-sort). Verifies each board column sorts by its
 * lifecycle-appropriate key and direction.
 */

function claimant(claimedAt: string): TaskClaimant {
  return {
    userId: '00000000-0000-0000-0000-000000000001',
    displayName: 'x',
    avatarColor: '#000000',
    hasAvatar: false,
    points: null,
    claimedAt,
  };
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    projectId: null,
    projectName: null,
    projectKey: null,
    title: over.id,
    description: null,
    status: 'open',
    points: null,
    priority: 'medium',
    minClaimants: 1,
    maxClaimants: null,
    dueDate: null,
    createdBy: '00000000-0000-0000-0000-000000000001',
    rank: 'm',
    completedAt: null,
    deliveredAt: null,
    deliveredBy: null,
    reviewedBy: null,
    claimants: [],
    labels: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

function order(status: TaskStatus, tasks: Task[]): string[] {
  return [...tasks].sort(compareTasksInColumn(status)).map((t) => t.id);
}

describe('compareTasksInColumn', () => {
  it('待认领 open: urgency desc, then oldest-waiting first on ties', () => {
    const mk = (id: string, priority: Priority, createdAt: string) =>
      task({ id, status: 'open', priority, createdAt });
    const tasks = [
      mk('low', 'low', '2026-01-01T00:00:00.000Z'),
      mk('urgent', 'urgent', '2026-01-05T00:00:00.000Z'),
      mk('high', 'high', '2026-01-03T00:00:00.000Z'),
      mk('med-new', 'medium', '2026-02-01T00:00:00.000Z'),
      mk('med-old', 'medium', '2026-01-02T00:00:00.000Z'),
    ];
    // urgent > high > medium(oldest first) > low
    expect(order('open', tasks)).toEqual(['urgent', 'high', 'med-old', 'med-new', 'low']);
  });

  it('进行中 in_progress: by first-claim time, newest first', () => {
    const a = task({ id: 'a', status: 'in_progress', claimants: [claimant('2026-01-10T00:00:00.000Z')] });
    const b = task({ id: 'b', status: 'in_progress', claimants: [claimant('2026-01-20T00:00:00.000Z')] });
    // multi-claim uses the earliest claim → c entered at 01-05 (oldest), so it sinks
    const c = task({
      id: 'c',
      status: 'in_progress',
      claimants: [claimant('2026-01-25T00:00:00.000Z'), claimant('2026-01-05T00:00:00.000Z')],
    });
    expect(order('in_progress', [a, b, c])).toEqual(['b', 'a', 'c']);
  });

  it('待审阅 pending_review: by deliveredAt, oldest first (FIFO)', () => {
    const a = task({ id: 'a', status: 'pending_review', deliveredAt: '2026-01-10T00:00:00.000Z' });
    const b = task({ id: 'b', status: 'pending_review', deliveredAt: '2026-01-02T00:00:00.000Z' });
    const c = task({ id: 'c', status: 'pending_review', deliveredAt: '2026-01-20T00:00:00.000Z' });
    expect(order('pending_review', [a, b, c])).toEqual(['b', 'a', 'c']);
  });

  it('已完成 done: by completedAt, newest first', () => {
    const a = task({ id: 'a', status: 'done', completedAt: '2026-01-10T00:00:00.000Z' });
    const b = task({ id: 'b', status: 'done', completedAt: '2026-01-02T00:00:00.000Z' });
    const c = task({ id: 'c', status: 'done', completedAt: '2026-01-20T00:00:00.000Z' });
    expect(order('done', [a, b, c])).toEqual(['c', 'a', 'b']);
  });

  it('handles offset timezones by epoch, not lexicographically', () => {
    // 09:00+09:00 == 00:00Z; 23:30-01:00 == 00:30 next-day-Z. Lexicographic on the
    // raw strings would mis-order these; epoch compare must not.
    const earlier = task({ id: 'earlier', status: 'done', completedAt: '2026-03-02T09:00:00.000+09:00' });
    const later = task({ id: 'later', status: 'done', completedAt: '2026-03-01T23:30:00.000-01:00' });
    expect(order('done', [earlier, later])).toEqual(['later', 'earlier']);
  });
});
