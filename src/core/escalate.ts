import { severityOf } from '@/core/alert-severity.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import {
  refuseInactiveSession,
  requireBoundedText,
  requireRoot,
  requireTask,
} from '@/core/record-checks.ts';
import { lockOwned } from '@/core/session-lock.ts';
import type { AlertRecord } from '@/domain/background-jobs.ts';
import { escalationCap, escalationWindowMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { GroupId, SessionId, WorkspaceId } from '@/domain/ids.ts';
import { redactCredentials } from '@/domain/message.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { formatTime } from '@/domain/time.ts';
import { requireAllowed } from '@/policy/policy.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

const reasonLimitBytes = 1024;

/**
 * Open an alert that asks a person to look at this session, or update the reason of the one it
 * already has.
 *
 * <p>An escalation is the one alert that a request writes instead of the usage poll, so it is
 * written under the session's own locks, not under a job lock. The poll only keeps it open and
 * clears it. A session that sends the same reason again changes nothing, and a group opens at
 * most {@link escalationCap} escalations an hour, so a group whose sessions all escalate cannot
 * flood the alerts.
 *
 * <p>The reason is capped in bytes, and only this service's own tokens are redacted from it.
 */
export async function escalateSession(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; sessionId: SessionId; reason: string }
): Promise<AlertRecord> {
  const reason = redactCredentials(requireBoundedText(input.reason, 'reason', reasonLimitBytes));

  return deps.store.transact(async tx => {
    const session = await lockOwned(tx, input.workspaceId, input.sessionId);

    refuseSessionThatCannotEscalate(session);
    await requireAllowedToEscalate(tx, session);

    const now = deps.clock.now();
    const existing = await tx.openAlertByKey('escalation', session.id);

    if (existing !== null) return updateReason(tx, existing, reason, now);

    await refuseWhenGroupOpenedItsEscalations(tx, session.group_id, now);

    return openEscalation(deps, tx, session, reason, now);
  });
}

function refuseSessionThatCannotEscalate(session: SessionRecord): void {
  refuseInactiveSession(session, {
    lives: ['starting', 'ended', 'start_failed'],
    message: 'This session cannot escalate.',
  });
}

async function requireAllowedToEscalate(tx: UnitOfWork, session: SessionRecord): Promise<void> {
  const task = await requireTask(tx, session.workspace_id, session.task_id, session.group_id);
  const root = await requireRoot(tx, session.workspace_id, session.group_id);

  requireAllowed({
    role: session.role,
    action: 'escalate',
    released: session.life === 'released',
    taskKind: task.parent_id === null ? 'root' : 'child',
    taskState: task.state,
    relation: 'own',
    rootState: root.state,
    targetRole: session.role,
    targetStartedByCaller: false,
    targetTaskClosed: false,
  });
}

async function updateReason(
  tx: UnitOfWork,
  existing: AlertRecord,
  reason: string,
  now: Date
): Promise<AlertRecord> {
  if (existing.reason === reason) return existing;

  const lastSeenAt = formatTime(now);

  await tx.updateAlertReason(existing.id, reason, lastSeenAt);

  return { ...existing, reason, lastSeenAt };
}

async function refuseWhenGroupOpenedItsEscalations(
  tx: UnitOfWork,
  groupId: GroupId,
  now: Date
): Promise<void> {
  const opened = await tx.countEscalations(
    groupId,
    formatTime(new Date(now.getTime() - escalationWindowMs))
  );

  if (opened < escalationCap) return;

  console.warn(
    `Group ${groupId} opened its ${escalationCap} escalations for the hour, so another one is refused`
  );

  throw new HivemindError('rate_limited', 'This group has opened its escalations for the hour.');
}

async function openEscalation(
  deps: ServiceDeps,
  tx: UnitOfWork,
  session: SessionRecord,
  reason: string,
  now: Date
): Promise<AlertRecord> {
  const openedAt = formatTime(now);
  const alert: AlertRecord = {
    id: deps.ids.alert(),
    workspaceId: session.workspace_id,
    groupId: session.group_id,
    rule: 'escalation',
    targetId: session.id,
    severity: severityOf('escalation'),
    reason,
    openedAt,
    lastSeenAt: openedAt,
    clearedAt: null,
  };

  await tx.insertAlert(alert);

  return alert;
}
