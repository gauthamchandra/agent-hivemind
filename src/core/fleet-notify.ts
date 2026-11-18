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
  const findings = await deps.store.transact(tx => tx.loadFleet());
  const pending = findings.findings.filter(finding => finding.notify && finding.clearedAt === null);
  const buckets = new Map<string, FindingBucket>();

  for (const finding of pending) {
    for (const kind of findingAudience(finding.rule)) {
      const id = recipientId(snapshot, finding, kind);

      if (id === null) continue;

      const key = `${kind}:${id}`;
      const bucket = buckets.get(key) ?? { kind, id, findings: [] as FindingRecord[] };

      bucket.findings.push(finding);
      buckets.set(key, bucket);
    }
  }

  for (const bucket of buckets.values()) {
    bucket.findings.sort(bySeverity);
    const deliveryId = sha256Hex(
      `${bucket.kind}:${bucket.id}:${bucket.findings
        .map(finding => finding.id)
        .sort()
        .join(',')}`
    );
    const previous = findings.attempts.find(attempt => attempt.deliveryId === deliveryId);

    if (previous?.state === 'failed' && age(previous.createdAt, deps) >= notifyGiveUpMs) {
      continue;
    }

    if (previous?.state === 'sending' && age(previous.updatedAt, deps) < notifyRetryMs) {
      continue;
    }

    const notification = toNotification(snapshot, bucket, deliveryId, now);

    if (notifier === null) {
      await markSent(deps, bucket, deliveryId, now, epoch);
      continue;
    }

    await deps.store.transact(async tx => {
      if (!(await tx.holdLease('fleet_check', epoch, now))) return;

      const workspaceId = bucket.findings[0]?.workspaceId;

      if (previous === undefined && workspaceId !== undefined) {
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
      }
    });

    try {
      await notifier.deliver(notification);
      await markSent(deps, bucket, deliveryId, formatTime(deps.clock.now()), epoch);
    } catch {
      await deps.store.transact(tx =>
        tx.finishAttempt(deliveryId, 'failed', formatTime(deps.clock.now()))
      );
    }
  }
}

async function markSent(
  deps: ServiceDeps,
  bucket: FindingBucket,
  deliveryId: string,
  now: string,
  epoch: number
): Promise<void> {
  await deps.store.transact(async tx => {
    if (!(await tx.holdLease('fleet_check', epoch, now))) return;

    await tx.finishAttempt(deliveryId, 'sent', now);

    for (const finding of bucket.findings) await tx.noteNotified(finding.id, now);
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
  if (finding.acknowledgedAt !== null || finding.notifiedAt === null) return false;

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
