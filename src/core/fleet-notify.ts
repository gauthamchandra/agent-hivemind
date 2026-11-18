import type { ServiceDeps } from '@/core/deps.ts';
import { findingAudience, findingWords } from '@/core/finding-text.ts';
import { HivemindError } from '@/domain/errors.ts';
import { sha256Hex } from '@/domain/secret.ts';
import type { FindingRecord, FleetSnapshot } from '@/domain/supervision.ts';
import {
  notifyGiveUpMs,
  notifyRetryMs,
  reminderCriticalMs,
  reminderNormalMs,
} from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';
import type { Notification, NotificationFinding, Notifier } from '@/ports/notifier.ts';
export async function deliverFindings(
  deps: ServiceDeps,
  notifier: Notifier | null,
  snapshot: FleetSnapshot,
  epoch: number
): Promise<void> {
  const now = formatTime(deps.clock.now());
  const loaded = await deps.store.transact(tx => tx.loadFleet());

  for (const attempt of loaded.attempts) {
    if (!retryAttempt(attempt, deps)) continue;

    const findings = findingsFor(loaded.findings, attempt.findingIds);

    if (findings.length === 0) continue;

    await sendBucket(
      deps,
      notifier,
      snapshot,
      { kind: attempt.recipientKind, id: attempt.recipientId, findings },
      attempt.deliveryId,
      epoch,
      now,
      false
    );
  }

  const current = await deps.store.transact(tx => tx.loadFleet());

  for (const bucket of freshBuckets(snapshot, current)) {
    await sendBucket(deps, notifier, snapshot, bucket, deliveryIdFor(bucket), epoch, now, true);
  }
}

function retryAttempt(attempt: FleetSnapshot['attempts'][number], deps: ServiceDeps): boolean {
  if (attempt.state === 'sending') return age(attempt.updatedAt, deps) >= notifyRetryMs;
  if (attempt.state === 'failed') return age(attempt.createdAt, deps) < notifyGiveUpMs;

  return false;
}

function findingsFor(findings: FindingRecord[], ids: string[]): FindingRecord[] {
  return ids
    .map(id => findings.find(finding => finding.id === id))
    .filter(
      (finding): finding is FindingRecord => finding !== undefined && finding.clearedAt === null
    );
}

function freshBuckets(snapshot: FleetSnapshot, loaded: FleetSnapshot): FindingBucket[] {
  const buckets = new Map<string, FindingBucket>();

  for (const finding of loaded.findings) {
    if (!finding.notify || finding.clearedAt !== null) continue;

    for (const kind of findingAudience(finding.rule)) {
      const id = recipientId(snapshot, finding, kind);

      if (id === null || loaded.attempts.some(attempt => covers(attempt, kind, id, finding))) {
        continue;
      }

      const key = `${kind}:${id}`;
      const bucket = buckets.get(key) ?? { kind, id, findings: [] as FindingRecord[] };

      bucket.findings.push(finding);
      buckets.set(key, bucket);
    }
  }

  for (const bucket of buckets.values()) bucket.findings.sort(bySeverity);

  return [...buckets.values()];
}

async function sendBucket(
  deps: ServiceDeps,
  notifier: Notifier | null,
  snapshot: FleetSnapshot,
  bucket: FindingBucket,
  deliveryId: string,
  epoch: number,
  now: string,
  insert: boolean
): Promise<void> {
  if (!(await deps.store.transact(tx => tx.holdLease('fleet_check', epoch, now)))) return;
  if (insert && !(await recordSending(deps, bucket, deliveryId, epoch, now))) return;
  if (notifier === null) {
    await markSent(deps, snapshot, bucket, deliveryId, now, epoch);

    return;
  }

  try {
    await notifier.deliver(toNotification(snapshot, bucket, deliveryId, now));
    await markSent(deps, snapshot, bucket, deliveryId, formatTime(deps.clock.now()), epoch);
  } catch {
    const failedAt = formatTime(deps.clock.now());

    await deps.store.transact(async tx => {
      if (!(await tx.holdLease('fleet_check', epoch, failedAt))) return;

      await tx.finishAttempt(deliveryId, 'failed', failedAt);
    });
  }
}

function deliveryIdFor(bucket: FindingBucket): string {
  const stamp = bucket.findings
    .map(finding => `${finding.id}@${finding.notifiedAt ?? ''}`)
    .sort()
    .join(',');

  return sha256Hex(`${bucket.kind}:${bucket.id}:${stamp}`);
}

async function recordSending(
  deps: ServiceDeps,
  bucket: FindingBucket,
  deliveryId: string,
  epoch: number,
  now: string
): Promise<boolean> {
  const workspaceId = bucket.findings[0]?.workspaceId;

  if (workspaceId === undefined) return false;

  return deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', epoch, now))) return false;

    await tx.insertAttempt({
      id: deliveryId,
      workspaceId,
      deliveryId,
      recipientKind: bucket.kind,
      recipientId: bucket.id,
      findingIds: bucket.findings.map(finding => finding.id),
      state: 'sending',
      createdAt: now,
      updatedAt: now,
    });

    return true;
  });
}

function covers(
  attempt: FleetSnapshot['attempts'][number],
  kind: FindingBucket['kind'],
  id: string,
  finding: FindingRecord
): boolean {
  if (attempt.recipientKind !== kind || attempt.recipientId !== id) return false;
  if (!attempt.findingIds.includes(finding.id)) return false;
  if (finding.notifiedAt === null) return true;

  return Date.parse(attempt.createdAt) > Date.parse(finding.notifiedAt);
}

async function markSent(
  deps: ServiceDeps,
  snapshot: FleetSnapshot,
  bucket: FindingBucket,
  deliveryId: string,
  now: string,
  epoch: number
): Promise<void> {
  await deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', epoch, now))) return;

    await tx.finishAttempt(deliveryId, 'sent', now);

    const loaded = await tx.loadFleet();

    for (const finding of bucket.findings) {
      if (audiencesSent(snapshot, finding, loaded.attempts)) {
        await tx.noteNotified(finding.id, now);
      }
    }
  });
}

function audiencesSent(
  snapshot: FleetSnapshot,
  finding: FindingRecord,
  attempts: FleetSnapshot['attempts']
): boolean {
  return findingAudience(finding.rule).every(kind => {
    const id = recipientId(snapshot, finding, kind);

    if (id === null) return true;

    return attempts.some(
      attempt =>
        attempt.state === 'sent' &&
        attempt.recipientKind === kind &&
        attempt.recipientId === id &&
        attempt.findingIds.includes(finding.id)
    );
  });
}

function toNotification(
  snapshot: FleetSnapshot,
  bucket: FindingBucket,
  deliveryId: string,
  sentAt: string
): Notification {
  const findings: NotificationFinding[] = bucket.findings.map(finding => {
    const text = findingWords(finding.rule);
    const group = snapshot.groups.find(item => item.id === finding.groupId);
    const session = snapshot.sessions.find(item => item.id === finding.targetId);
    const task = snapshot.tasks.find(item => item.id === (session?.task_id ?? finding.targetId));

    return {
      id: finding.id,
      rule: finding.rule,
      severity: finding.severity,
      words: text.words,
      groupName: group?.name ?? '',
      taskTitle: task?.title ?? null,
      role: session?.role ?? null,
      openFor: `${Math.max(0, Math.floor((Date.parse(sentAt) - Date.parse(finding.openedAt)) / 60000))} minutes`,
      action: text.action,
      reason: finding.reason,
      sessionAddress: session?.platform_address ?? null,
    };
  });

  const workspaceId = bucket.findings[0]?.workspaceId;

  if (workspaceId === undefined) {
    throw new HivemindError('unavailable', 'A notification had no finding.');
  }

  return {
    deliveryId,
    workspaceId,
    sentAt,
    recipient: { kind: bucket.kind, id: bucket.id, subject: null, address: null },
    findings,
  };
}

type FindingBucket = {
  kind: 'owner' | 'administrator';
  id: string;
  findings: FindingRecord[];
};

function recipientId(
  snapshot: FleetSnapshot,
  finding: FindingRecord,
  kind: 'owner' | 'administrator'
): string | null {
  if (kind === 'administrator') return finding.workspaceId;

  const group = snapshot.groups.find(item => item.id === finding.groupId);

  return group?.owner_person_id ?? null;
}

export function remind(finding: FindingRecord, nowMs: number): boolean {
  if (finding.notifiedAt === null) return false;

  const limit = finding.severity === 'critical' ? reminderCriticalMs : reminderNormalMs;

  return nowMs - Date.parse(finding.notifiedAt) >= limit;
}

function bySeverity(left: FindingRecord, right: FindingRecord): number {
  if (left.severity === right.severity) return left.openedAt < right.openedAt ? -1 : 1;

  return left.severity === 'critical' ? -1 : 1;
}

function age(at: string, deps: ServiceDeps): number {
  return deps.clock.now().getTime() - Date.parse(at);
}
