import type { ServiceDeps } from '@/core/deps.ts';
import type { Evaluation } from '@/core/finding-rules.ts';
import { desiredFindings } from '@/core/finding-rules.ts';
import { finishOpenObservations, observeSession } from '@/core/fleet-observe.ts';

export { commitObservation } from '@/core/fleet-observe.ts';

import { deliverFindings, remind } from '@/core/fleet-notify.ts';
import {
  type RunOptions,
  SupervisionHalted,
  type TickResult,
  takeJob,
} from '@/core/supervision-run.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord, SessionRole } from '@/domain/model.ts';
import type { Capability } from '@/domain/platform.ts';
import type { FindingRecord, FleetSnapshot } from '@/domain/supervision.ts';
import {
  findingKey,
  fleetDeadlineMs,
  fleetIntervalMs,
  recordsPerWorkspace,
  statusDependentRules,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Notifier } from '@/ports/notifier.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function runFleetCheck(
  deps: ServiceDeps,
  platforms: Platforms,
  notifier: Notifier | null,
  options: RunOptions
): Promise<TickResult> {
  const epoch = await takeJob(deps, 'fleet_check', options.workerId, fleetIntervalMs);

  if (epoch === null) return { ran: false, epoch: null };

  const started = deps.clock.now().getTime();
  const snapshot = await deps.store.transact(tx => tx.loadFleet());
  const handled = await finishOpenObservations(deps, platforms, snapshot, epoch);
  const unreliable = new Set<string>();
  const grew = new Set<string>();

  for (const session of batch(snapshot)) {
    if (deps.clock.now().getTime() - started > fleetDeadlineMs) break;
    if (handled.has(session.id)) continue;

    try {
      const growth = await observeSession(
        deps,
        platforms,
        snapshot,
        session,
        epoch,
        options,
        unreliable
      );

      if (growth) grew.add(session.task_id);
    } catch (error) {
      if (error instanceof SupervisionHalted) throw error;
      if (error instanceof HivemindError && error.code === 'conflict') throw error;

      console.error(`Fleet check skipped session ${session.id}.`);
    }
  }

  const described = describeConnections(platforms, snapshot);

  await syncFindings(deps, snapshot, epoch, unreliable, grew, described);
  await deliverFindings(deps, notifier, snapshot, epoch);

  return { ran: true, epoch };
}

async function syncFindings(
  deps: ServiceDeps,
  snapshot: FleetSnapshot,
  epoch: number,
  unreliable: Set<string>,
  grew: Set<string>,
  described: ReturnType<typeof describeConnections>
): Promise<void> {
  const nowMs = deps.clock.now().getTime();
  const now = formatTime(new Date(nowMs));
  const evaluation = evaluationOf(snapshot, nowMs, grew, described);
  const desired = desiredFindings(evaluation);
  const open = snapshot.findings.filter(finding => finding.clearedAt === null);
  const keys = new Set(desired.map(item => findingKey(item.rule, item.targetId)));

  await deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', epoch, now))) {
      throw new HivemindError('conflict', 'The lease epoch is no longer current.');
    }

    for (const item of desired) {
      if (skipStatusRule(snapshot, item.rule, item.targetId, unreliable)) continue;

      const existing = open.find(
        finding => finding.rule === item.rule && finding.targetId === item.targetId
      );

      if (existing === undefined) {
        await tx.insertFinding({
          id: deps.ids.finding(),
          workspaceId: item.workspaceId,
          groupId: item.groupId,
          rule: item.rule,
          targetId: item.targetId,
          severity: item.severity,
          reason: item.reason,
          openedAt: now,
          lastSeenAt: now,
          notifiedAt: null,
          acknowledgedAt: null,
          clearedAt: null,
          notify: true,
        });
        continue;
      }

      await tx.touchFinding(existing.id, now);

      if (remind(existing, nowMs)) await tx.markFindingNotify(existing.id);
    }

    for (const existing of open) {
      if (keys.has(findingKey(existing.rule, existing.targetId))) continue;
      if (skipStatusRule(snapshot, existing.rule, existing.targetId, unreliable)) continue;

      await tx.clearFinding(existing.id, now);
    }
  });
}
function describeConnections(platforms: Platforms, snapshot: FleetSnapshot) {
  const ceilings = new Map<string, Partial<Record<SessionRole, number>>>();
  const capabilities = new Map<string, readonly Capability[]>();

  for (const connection of snapshot.connections) {
    try {
      const handle = platforms.require(connection.id);
      const facts = handle.adapter.describe();

      ceilings.set(connection.id, facts.roleCeilings);
      capabilities.set(connection.id, handle.connection.capabilities);
    } catch {
      capabilities.set(connection.id, []);
    }
  }

  for (const group of snapshot.groups) {
    if (capabilities.has(group.connection_id)) continue;

    try {
      const handle = platforms.require(group.connection_id);

      ceilings.set(group.connection_id, handle.adapter.describe().roleCeilings);
      capabilities.set(group.connection_id, handle.connection.capabilities);
    } catch {
      capabilities.set(group.connection_id, []);
    }
  }

  return { ceilings, capabilities };
}

function evaluationOf(
  snapshot: FleetSnapshot,
  nowMs: number,
  grew: Set<string>,
  described: ReturnType<typeof describeConnections>
): Evaluation {
  const activityAt = new Map(snapshot.taskActivityAt.map(row => [row.taskId, Date.parse(row.at)]));

  for (const taskId of grew) activityAt.set(taskId, nowMs);

  return {
    nowMs,
    groups: snapshot.groups,
    tasks: snapshot.tasks,
    sessions: snapshot.sessions,
    waits: snapshot.waits,
    watches: new Map(snapshot.watches.map(watch => [watch.sessionId, watch])),
    ceilings: described.ceilings,
    capabilities: described.capabilities,
    queuedAt: new Map(snapshot.oldestQueuedAt.map(row => [row.connectionId, Date.parse(row.at)])),
    activityAt,
    relayed: new Set(snapshot.relayedSessionIds),
    expiredCodes: new Set(
      snapshot.unusedCodeExpires
        .filter(code => Date.parse(code.expiresAt) <= nowMs)
        .map(code => code.sessionId)
    ),
    connectionWatches: new Map(
      snapshot.connectionWatches.map(watch => [watch.connectionId, watch])
    ),
    findings: snapshot.findings,
  };
}

function batch(snapshot: FleetSnapshot): SessionRecord[] {
  const byWorkspace = new Map<string, SessionRecord[]>();

  for (const session of snapshot.sessions) {
    const list = byWorkspace.get(session.workspace_id) ?? [];

    list.push(session);
    byWorkspace.set(session.workspace_id, list);
  }

  const ordered: SessionRecord[] = [];

  for (const list of byWorkspace.values()) {
    list.sort((left, right) => observed(snapshot, left) - observed(snapshot, right));
    ordered.push(...list.slice(0, recordsPerWorkspace));
  }

  return ordered;
}

function observed(snapshot: FleetSnapshot, session: SessionRecord): number {
  const at = snapshot.watches.find(watch => watch.sessionId === session.id)?.lastObservedAt;

  return at === null || at === undefined ? 0 : Date.parse(at);
}

function skipStatusRule(
  snapshot: FleetSnapshot,
  rule: FindingRecord['rule'],
  targetId: string,
  unreliable: Set<string>
): boolean {
  if (!statusDependentRules.has(rule)) return false;

  const connection = connectionOf(snapshot, targetId);

  return connection !== null && unreliable.has(connection);
}

function connectionOf(snapshot: FleetSnapshot, targetId: string): string | null {
  const session = snapshot.sessions.find(item => item.id === targetId);
  const task = snapshot.tasks.find(item => item.id === (session?.task_id ?? targetId));
  const group = snapshot.groups.find(
    item => item.id === (session?.group_id ?? task?.group_id ?? targetId)
  );

  if (group) return group.connection_id;
  if (snapshot.connections.some(item => item.id === targetId)) return targetId;

  return null;
}
