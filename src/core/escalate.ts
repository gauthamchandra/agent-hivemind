import type { ServiceDeps } from '@/core/deps.ts';
import { requireBoundedText, requireRoot } from '@/core/record-checks.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionId, WorkspaceId } from '@/domain/ids.ts';
import { redactCredentials } from '@/domain/message.ts';
import type { FindingRecord } from '@/domain/supervision.ts';
import { escalationCap, escalationWindowMs, findingKey } from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import { requireAllowed } from '@/policy/policy.ts';

export async function escalateSession(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; sessionId: SessionId; reason: string }
): Promise<FindingRecord> {
  const reason = redactCredentials(requireBoundedText(input.reason, 'reason', 1024));
  const nowMs = deps.clock.now().getTime();
  const now = formatTime(new Date(nowMs));

  return deps.store.transact(async tx => {
    const session = await tx.lockSession(input.workspaceId, input.sessionId);

    if (session === null) {
      throw new HivemindError('not_found', 'No session with that identifier is in this workspace.');
    }

    if (session.life !== 'live' && session.life !== 'released') {
      throw new HivemindError('session_not_active', 'This session cannot escalate.');
    }

    const task = await tx.lockTask(input.workspaceId, session.task_id);
    const root = await requireRoot(tx, input.workspaceId, session.group_id);

    if (task === null) {
      throw new HivemindError('not_found', 'No task with that identifier is in this workspace.');
    }

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

    const group = await tx.lockGroup(input.workspaceId, session.group_id);

    if (group === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    const existing = await tx.openFindingByKey('escalation', session.id);

    if (existing !== null) {
      await tx.updateFindingReason(existing.id, reason, now);

      return { ...existing, reason, lastSeenAt: now };
    }

    const opened = await tx.countEscalations(
      group.id,
      formatTime(new Date(nowMs - escalationWindowMs))
    );

    if (opened >= escalationCap) {
      throw new HivemindError(
        'rate_limited',
        'This group has opened its escalations for the hour.'
      );
    }

    const finding: FindingRecord = {
      id: deps.ids.finding(),
      workspaceId: session.workspace_id,
      groupId: session.group_id,
      rule: 'escalation',
      targetId: session.id,
      severity: 'critical',
      reason,
      openedAt: now,
      lastSeenAt: now,
      notifiedAt: null,
      acknowledgedAt: null,
      clearedAt: null,
      notify: true,
    };

    await tx.insertFinding(finding);

    return finding;
  });
}

export async function acknowledgeFinding(
  deps: ServiceDeps,
  input: { workspaceId: WorkspaceId; findingId: string }
): Promise<FindingRecord> {
  const now = formatTime(deps.clock.now());
  const finding = await deps.store.transact(async tx => {
    const rows = await tx.listFindings(input.workspaceId);
    const current = rows.find(item => item.id === input.findingId);

    if (current === undefined) {
      throw new HivemindError('not_found', 'No finding with that identifier is in this workspace.');
    }

    return tx.acknowledgeFinding(current.id, now, current.rule === 'escalation');
  });

  if (finding === null) {
    throw new HivemindError('not_found', 'No finding with that identifier is in this workspace.');
  }

  return finding;
}

export function escalationKey(sessionId: string): string {
  return findingKey('escalation', sessionId);
}
