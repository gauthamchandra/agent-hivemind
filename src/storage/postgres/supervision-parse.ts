import type { ConnectionId, WorkspaceId } from '@/domain/ids.ts';
import {
  requireConnectionId,
  requireGroupId,
  requireSessionId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { Group, SessionRecord, Task } from '@/domain/model.ts';
import type {
  ConnectionWatch,
  FindingRecord,
  FleetSnapshot,
  NotificationAttempt,
  SessionWatch,
} from '@/domain/supervision.ts';
import { isFindingRule } from '@/domain/supervision.ts';
import { readBoolean } from '@/storage/postgres/session-read.ts';
import type { Row } from '@/storage/postgres/store-query.ts';
import {
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  readStringList,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function fleetSnapshot(input: {
  groups: Group[];
  tasks: Task[];
  sessions: SessionRecord[];
  waits: WaitRecord[];
  watches: SessionWatch[];
  connectionWatches: ConnectionWatch[];
  connections: { workspaceId: WorkspaceId; id: ConnectionId }[];
  oldestQueuedAt: Row[];
  taskActivityAt: Row[];
  relayed: Row[];
  unusedCodeExpires: { sessionId: string; expiresAt: string }[];
  findings: FindingRecord[];
  attempts: NotificationAttempt[];
}): FleetSnapshot {
  return {
    groups: input.groups,
    tasks: input.tasks,
    sessions: input.sessions,
    waits: input.waits,
    watches: input.watches,
    connectionWatches: input.connectionWatches,
    connections: input.connections,
    oldestQueuedAt: input.oldestQueuedAt.map(row => ({
      connectionId: readString(row, 'connection_id'),
      at: timeText(row, 'at'),
    })),
    taskActivityAt: input.taskActivityAt.map(row => ({
      taskId: readString(row, 'task_id'),
      at: timeText(row, 'at'),
    })),
    relayedSessionIds: input.relayed.map(row => readString(row, 'sender_id')),
    unusedCodeExpires: input.unusedCodeExpires,
    findings: input.findings,
    attempts: input.attempts,
  };
}

export function watchParams(watch: SessionWatch): unknown[] {
  return [
    watch.sessionId,
    watch.workspaceId,
    watch.badStatusStreak,
    watch.unknownStreak,
    watch.endUnconfirmedRuns,
    watch.endAttemptRuns,
    watch.inconclusiveRuns,
    watch.lastFind,
    watch.statusSince,
    watch.lastReadingAt,
    watch.suspendedAt,
    watch.suspendedProgressAt,
    watch.lastObservedAt,
    watch.orphanEnded,
  ];
}

export function parseWatch(row: Row): SessionWatch {
  const lastFind = readNullableString(row, 'last_find');

  if (
    lastFind !== null &&
    lastFind !== 'found' &&
    lastFind !== 'absent' &&
    lastFind !== 'inconclusive'
  ) {
    throw unreadable();
  }

  return {
    sessionId: requireSessionId(readString(row, 'session_id')),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    badStatusStreak: readNumber(row, 'bad_status_streak'),
    unknownStreak: readNumber(row, 'unknown_streak'),
    endUnconfirmedRuns: readNumber(row, 'end_unconfirmed_runs'),
    endAttemptRuns: readNumber(row, 'end_attempt_runs'),
    inconclusiveRuns: readNumber(row, 'inconclusive_runs'),
    lastFind,
    statusSince: readNullableTime(row.status_since_at),
    lastReadingAt: readNullableTime(row.last_reading_at),
    suspendedAt: readNullableTime(row.suspended_at),
    suspendedProgressAt: readNullableTime(row.suspended_progress_at),
    lastObservedAt: readNullableTime(row.last_observed_at),
    orphanEnded: readBoolean(row, 'orphan_ended'),
  };
}

export function parseConnectionWatch(row: Row): ConnectionWatch {
  return {
    connectionId: readString(row, 'connection_id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    authFailStreak: readNumber(row, 'auth_fail_streak'),
    probeFailed: readBoolean(row, 'probe_failed'),
    lastProbeAt: readNullableTime(row.last_probe_at),
  };
}

export function parseConnection(row: Row): { workspaceId: WorkspaceId; id: ConnectionId } {
  return {
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    id: requireConnectionId(readString(row, 'id')),
  };
}

export function parseFinding(row: Row): FindingRecord {
  const rule = readString(row, 'rule');
  const severity = readString(row, 'severity');
  const groupId = readNullableString(row, 'group_id');

  if (!isFindingRule(rule) || (severity !== 'normal' && severity !== 'critical'))
    throw unreadable();

  return {
    id: readString(row, 'id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    groupId: groupId === null ? null : requireGroupId(groupId),
    rule,
    targetId: readString(row, 'target_id'),
    severity,
    reason: readNullableString(row, 'reason'),
    openedAt: timeText(row, 'opened_at'),
    lastSeenAt: timeText(row, 'last_seen_at'),
    notifiedAt: readNullableTime(row.notified_at),
    acknowledgedAt: readNullableTime(row.acknowledged_at),
    clearedAt: readNullableTime(row.cleared_at),
    notify: readBoolean(row, 'notify'),
  };
}

export function findingParams(finding: FindingRecord): unknown[] {
  return [
    finding.id,
    finding.workspaceId,
    finding.groupId,
    finding.rule,
    finding.targetId,
    finding.severity,
    finding.reason,
    finding.openedAt,
    finding.lastSeenAt,
    finding.notifiedAt,
    finding.acknowledgedAt,
    finding.clearedAt,
    finding.notify,
  ];
}

export function parseAttempt(row: Row): NotificationAttempt {
  const kind = readString(row, 'recipient_kind');
  const state = readString(row, 'state');
  const ids = readStringList(jsonList(row.finding_ids));

  if (kind !== 'owner' && kind !== 'administrator') throw unreadable();
  if (state !== 'sending' && state !== 'sent' && state !== 'failed') throw unreadable();

  return {
    id: readString(row, 'id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    deliveryId: readString(row, 'delivery_id'),
    recipientKind: kind,
    recipientId: readString(row, 'recipient_id'),
    findingIds: ids,
    state,
    createdAt: timeText(row, 'created_at'),
    updatedAt: timeText(row, 'updated_at'),
  };
}

function jsonList(value: unknown): unknown {
  if (typeof value === 'string') return JSON.parse(value);

  return value;
}

function timeText(row: Row, key: string): string {
  const value = readNullableTime(row[key]);

  if (value === null) throw unreadable();

  return value;
}
