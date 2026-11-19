import type { Evaluation } from '@/core/alert-rules.ts';
import { desiredAlerts } from '@/core/alert-rules.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import type { AlertRule, JobSnapshot } from '@/domain/background-jobs.ts';
import { alertKey, statusDependentRules } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRole } from '@/domain/model.ts';
import type { Capability } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';

type AdapterFacts = {
  ceilings: Map<string, Partial<Record<SessionRole, number>>>;
  capabilities: Map<string, readonly Capability[]>;
};

export type ObservedInRun = {
  unreliableConnections: Set<string>;
  tasksWithUsageGrowth: Set<string>;
};

/**
 * Open the alerts the sessions now call for, keep the ones still true, and clear the ones that
 * ended.
 *
 * <p>A connection that failed to answer in this run is in {@code unreliableConnections}. The rules
 * that need the platform's answer neither open nor clear while it is, because a failed read says
 * nothing about the session.
 */
export async function syncAlerts(
  deps: ServiceDeps,
  platforms: Platforms,
  snapshot: JobSnapshot,
  lockId: number,
  observed: ObservedInRun
): Promise<void> {
  const { unreliableConnections: unreliable, tasksWithUsageGrowth: grew } = observed;
  const nowMs = deps.clock.now().getTime();
  const now = formatTime(new Date(nowMs));
  const facts = describeAdapters(platforms, snapshot, unreliable);
  const evaluation = evaluationOf(snapshot, nowMs, grew, facts);
  const desired = desiredAlerts(evaluation);
  const keys = new Set(desired.map(item => alertKey(item.rule, item.targetId)));

  await deps.store.transact(async tx => {
    if (!(await tx.holdJobLock('usage_poll', lockId, now))) {
      throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
    }

    for (const item of desired) {
      if (skipStatusRule(snapshot, item.rule, item.targetId, unreliable)) continue;

      const existing = snapshot.alerts.find(
        alert => alert.rule === item.rule && alert.targetId === item.targetId
      );

      if (existing === undefined) {
        await tx.insertAlert({
          id: deps.ids.alert(),
          workspaceId: item.workspaceId,
          groupId: item.groupId,
          rule: item.rule,
          targetId: item.targetId,
          severity: item.severity,
          reason: item.reason,
          openedAt: now,
          lastSeenAt: now,
          clearedAt: null,
          notifiedAt: null,
        });
      } else {
        await tx.touchAlert(existing.id, now);
      }
    }

    for (const existing of snapshot.alerts) {
      if (keys.has(alertKey(existing.rule, existing.targetId))) continue;
      if (skipStatusRule(snapshot, existing.rule, existing.targetId, unreliable)) continue;

      await tx.clearAlert(existing.id, now);
    }
  });
}

function describeAdapters(
  platforms: Platforms,
  snapshot: JobSnapshot,
  unreliable: Set<string>
): AdapterFacts {
  const facts: AdapterFacts = { ceilings: new Map(), capabilities: new Map() };

  for (const group of snapshot.groups) {
    if (facts.capabilities.has(group.connection_id)) continue;

    try {
      const handle = platforms.require(group.connection_id);

      facts.ceilings.set(group.connection_id, handle.adapter.describe().roleCeilings);
      facts.capabilities.set(group.connection_id, handle.connection.capabilities);
    } catch (error) {
      unreliable.add(group.connection_id);
      facts.capabilities.set(group.connection_id, []);
      console.warn(
        `Alerts could not describe connection ${group.connection_id}. Its role ceilings are unknown and its spend is reported as unknown.`,
        error
      );
    }
  }

  return facts;
}

function evaluationOf(
  snapshot: JobSnapshot,
  nowMs: number,
  grew: Set<string>,
  facts: AdapterFacts
): Evaluation {
  const activityAt = new Map(snapshot.taskActivityAt.map(row => [row.taskId, Date.parse(row.at)]));

  for (const taskId of grew) activityAt.set(taskId, nowMs);

  return {
    nowMs,
    groups: snapshot.groups,
    tasks: snapshot.tasks,
    sessions: snapshot.sessions,
    waits: snapshot.waits,
    jobStates: new Map(snapshot.sessionJobStates.map(jobState => [jobState.sessionId, jobState])),
    ceilings: facts.ceilings,
    capabilities: facts.capabilities,
    queuedAt: new Map(snapshot.oldestQueuedAt.map(row => [row.connectionId, Date.parse(row.at)])),
    activityAt,
    relayed: new Set(snapshot.relayedSessionIds),
    orphanEnded: snapshot.orphanEndedSessions,
    expiredCodes: new Set(
      snapshot.unusedCodeExpires
        .filter(code => Date.parse(code.expiresAt) <= nowMs)
        .map(code => code.sessionId)
    ),
    alerts: snapshot.alerts,
  };
}

function skipStatusRule(
  snapshot: JobSnapshot,
  rule: AlertRule,
  targetId: string,
  unreliable: Set<string>
): boolean {
  if (!statusDependentRules.has(rule)) return false;

  const connection = connectionOf(snapshot, targetId);

  return connection !== null && unreliable.has(connection);
}

function connectionOf(snapshot: JobSnapshot, targetId: string): string | null {
  const session = snapshot.sessions.find(item => item.id === targetId);
  const task = snapshot.tasks.find(item => item.id === (session?.task_id ?? targetId));
  const group = snapshot.groups.find(
    item => item.id === (session?.group_id ?? task?.group_id ?? targetId)
  );

  return group === undefined ? null : group.connection_id;
}
