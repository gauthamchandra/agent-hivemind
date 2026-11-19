import { expect } from 'bun:test';
import {
  createFirstAdministrator,
  createOperatorKey,
  openInstallation,
} from '@/core/installation.ts';
import { reportTransition } from '@/core/report-records.ts';
import { noteActivity } from '@/core/session-activity.ts';
import { openGroup } from '@/core/session-open.ts';
import { createChildTask } from '@/core/task-records.ts';
import { defaultWorkspaceId, type GroupId, type SessionId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { bootService } from '@/testing/boot.ts';
import type { TestDeps } from '@/testing/deps.ts';
import { checkoutGroup, note } from '@/testing/fixtures.ts';
import { simulatedAdapterName } from '@/testing/platforms.ts';

/**
 * Boot the service with a first administrator, a simulated connection, and one open group whose
 * planner is live and has reported activity.
 */
export async function team() {
  const service = await bootService();
  const { deps } = service;
  const installation = await openInstallation(deps);
  const secret = requirePresent(
    installation.bootstrapSecret,
    'the empty store should print a bootstrap key'
  );
  const admin = await createFirstAdministrator(deps, {
    bootstrapSecret: secret,
    displayName: 'Ada',
  });

  await createOperatorKey(deps, {
    bootstrapSecret: secret,
    name: 'creator',
    role: 'creator',
    expiresAt: null,
  });
  await deps.store.saveConnection({
    workspaceId: defaultWorkspaceId,
    id: service.connectionId,
    adapter: simulatedAdapterName,
    createdAt: formatTime(deps.clock.now()),
  });

  const opened = await openGroup(deps, service.platforms, {
    workspaceId: defaultWorkspaceId,
    personId: admin.id,
    ...checkoutGroup,
    connectionId: service.connectionId,
    verificationMode: 'before_merge',
    notes: [],
    idempotencyKey: 'background-jobs-group',
    bodyHash: 'background-jobs-group',
  });

  expect(opened.outcome).toBe('live');
  if (opened.outcome !== 'live') throw new Error('planner did not start');

  await noteActivity(deps, defaultWorkspaceId, opened.session.id, false);

  return { ...service, admin, opened, planner: opened.session };
}

/** Create a child task under the group's root, moving the root to analyzing first when needed. */
export async function addChild(deps: TestDeps, groupId: GroupId, plannerId: SessionId) {
  const tasks = await deps.store.tasks(defaultWorkspaceId, groupId);
  const root = tasks.find(task => task.parent_id === null);

  if (root?.state === 'planned') {
    await reportTransition(deps, {
      workspaceId: defaultWorkspaceId,
      groupId: root.group_id,
      taskId: root.id,
      expectedVersion: root.version,
      actor: { kind: 'session', role: 'planner', sessionId: plannerId, live: true },
      to: 'analyzing',
      note,
      evidence: [],
      nextVerificationMode: null,
    });
  }

  const created = await createChildTask(deps, {
    workspaceId: defaultWorkspaceId,
    groupId: root?.group_id ?? groupId,
    actor: { sessionId: plannerId, live: true },
    title: 'Tax interface',
    description: 'A child task with enough description to be stored.',
    verificationMode: null,
    dependsOn: [],
  });

  return created.task.id;
}
