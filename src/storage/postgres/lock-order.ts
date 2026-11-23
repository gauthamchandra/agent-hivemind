import type { UnitOfWork } from '@/ports/storage.ts';

const lockOrder = ['job lock', 'workspace', 'group', 'root task', 'child task', 'session'] as const;

type LockLevel = (typeof lockOrder)[number];

/**
 * Refuse a lock that a transaction takes after a lock that comes later in the order.
 *
 * <p>The order is the one in {@code docs/architecture.md}. Two transactions that take the same
 * locks in different orders can deadlock, and an in-process database runs one transaction at a
 * time, so no test would ever see it. This turns the first out-of-order lock on any path into an
 * error.
 *
 * <p>A background job's lock row is the first level. {@code takeJobLock}, {@code holdJobLock},
 * {@code insertPlannedAction}, and {@code finishPlannedAction} write that row, so each is checked before it runs.
 *
 * <p>Locking something the transaction already holds is allowed, because it waits for nothing.
 * A lock that finds no row holds nothing, so it does not count.
 *
 * <p>A task's level is known only once its row is read. Before waiting, a task lock is checked
 * as a child task, the later of the two task levels, so only a lock that is out of order for
 * certain is refused up front. Once the row is read, the lock is checked again as the root or
 * child task it is. {@code openChildren} locks every open child of a parent, so it counts as
 * locking child tasks. It is checked after its rows are read, because the children it returns
 * may all be held already. {@code lockGroupsWithOutbox} locks several groups and returns their
 * ids, so each counts as a group lock and can be locked again later.
 *
 * <p><b>IMPORTANT:</b> any new method that takes a row lock must be wrapped here, or the check
 * has a hole.
 */
export function inLockOrder(work: UnitOfWork): UnitOfWork {
  const held = new Set<string>();
  let deepestLevel: LockLevel | null = null;

  function refuseIfBeforeDeepest(level: LockLevel): void {
    if (deepestLevel === null || lockOrder.indexOf(level) >= lockOrder.indexOf(deepestLevel)) {
      return;
    }

    throw new Error(
      `Lock order violated: ${level} locked after ${deepestLevel}. The order is ${lockOrder.join(', ')}.`
    );
  }

  function hold(key: string, level: LockLevel): void {
    refuseIfBeforeDeepest(level);
    held.add(key);
    deepestLevel = level;
  }

  async function lock<Row>(
    key: string,
    levelBeforeWaiting: LockLevel,
    take: () => Promise<Row | null>,
    levelOf: (row: Row) => LockLevel
  ): Promise<Row | null> {
    if (held.has(key)) return take();

    refuseIfBeforeDeepest(levelBeforeWaiting);

    const row = await take();

    if (row === null) return null;

    hold(key, levelOf(row));

    return row;
  }

  return {
    ...work,
    ...jobLockWrites(work, job => {
      if (!held.has(`job_lock:${job}`)) hold(`job_lock:${job}`, 'job lock');
    }),

    lockWorkspace(id) {
      return lock(
        `workspace:${id}`,
        'workspace',
        () => work.lockWorkspace(id),
        () => 'workspace'
      );
    },

    lockGroup(workspaceId, id) {
      return lock(
        `group:${id}`,
        'group',
        () => work.lockGroup(workspaceId, id),
        () => 'group'
      );
    },

    lockTask(workspaceId, id) {
      return lock(
        `task:${id}`,
        'child task',
        () => work.lockTask(workspaceId, id),
        task => (task.parent_id === null ? 'root task' : 'child task')
      );
    },

    async lockGroupsWithOutbox(deadline) {
      refuseIfBeforeDeepest('group');

      const groupIds = await work.lockGroupsWithOutbox(deadline);

      for (const groupId of groupIds) hold(`group:${groupId}`, 'group');

      return groupIds;
    },

    async correctCounters() {
      refuseIfBeforeDeepest('workspace');

      const corrected = await work.correctCounters();

      hold('every workspace', 'workspace');
      hold('every group', 'group');

      return corrected;
    },

    ...closedGroupRemoval(work, held, hold, refuseIfBeforeDeepest),

    async openChildren(workspaceId, groupId, parentId) {
      const children = await work.openChildren(workspaceId, groupId, parentId);

      for (const child of children) {
        if (!held.has(`task:${child.id}`)) hold(`task:${child.id}`, 'child task');
      }

      return children;
    },

    lockSession(workspaceId, id) {
      return lock(
        `session:${id}`,
        'session',
        () => work.lockSession(workspaceId, id),
        () => 'session'
      );
    },
  };
}

function closedGroupRemoval(
  work: UnitOfWork,
  held: Set<string>,
  hold: (key: string, level: LockLevel) => void,
  refuseIfBeforeDeepest: (level: LockLevel) => void
): Pick<UnitOfWork, 'removeClosedGroup'> {
  return {
    async removeClosedGroup(input) {
      refuseIfBeforeDeepest('job lock');

      const outcome = await work.removeClosedGroup(input);

      if (outcome === 'stale') return outcome;

      if (!held.has('job_lock:housekeeping')) hold('job_lock:housekeeping', 'job lock');
      if (outcome === 'missing') return outcome;

      hold(`group:${input.groupId}`, 'group');
      hold(`tasks-of:${input.groupId}`, 'child task');
      hold(`sessions-of:${input.groupId}`, 'session');

      return outcome;
    },
  };
}

function jobLockWrites(
  work: UnitOfWork,
  holdJobLockLevel: (job: string) => void
): Pick<UnitOfWork, 'takeJobLock' | 'holdJobLock' | 'insertPlannedAction' | 'finishPlannedAction'> {
  return {
    takeJobLock(input) {
      holdJobLockLevel(input.job);

      return work.takeJobLock(input);
    },
    holdJobLock(job, lockId, now) {
      holdJobLockLevel(job);

      return work.holdJobLock(job, lockId, now);
    },
    insertPlannedAction(input) {
      holdJobLockLevel(input.job);

      return work.insertPlannedAction(input);
    },
    finishPlannedAction(id, job, lockId, now) {
      holdJobLockLevel(job);

      return work.finishPlannedAction(id, job, lockId, now);
    },
  };
}
