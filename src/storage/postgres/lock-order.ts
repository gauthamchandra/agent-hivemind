import type { UnitOfWork } from '@/ports/storage.ts';

const lockOrder = ['workspace', 'group', 'root task', 'child task', 'session'] as const;

type LockLevel = (typeof lockOrder)[number];

/**
 * Refuse a lock that a transaction takes after a lock that comes later in the order.
 *
 * <p>The order is the one in {@code docs/architecture.md}. Two transactions that take the same
 * locks in different orders can deadlock, and an in-process database runs one transaction at a
 * time, so no test would ever see it. This turns the first out-of-order lock on any path into an
 * error.
 *
 * <p>Locking something the transaction already holds is allowed, because it waits for nothing.
 * A lock that finds no row holds nothing, so it does not count.
 *
 * <p>A task's level is known only once its row is read. Before waiting, a task lock is checked
 * as a child task, the later of the two task levels, so only a lock that is out of order for
 * certain is refused up front. Once the row is read, the lock is checked again as the root or
 * child task it is. {@code openChildren} locks every open child of a parent, so it counts as
 * locking child tasks. It is checked after its rows are read, because the children it returns
 * may all be held already. {@code lockGroupsWithOutbox} locks groups it cannot name, so it
 * counts as a group lock.
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

      await work.lockGroupsWithOutbox(deadline);

      deepestLevel = 'group';
    },

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
