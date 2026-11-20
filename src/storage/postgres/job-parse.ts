import type { AlertRecord, JobSnapshot, SessionJobState } from '@/domain/background-jobs.ts';
import { isAlertRule } from '@/domain/background-jobs.ts';
import {
  requireAlertId,
  requireGroupId,
  requireSessionId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import { readBoolean } from '@/storage/postgres/session-read.ts';
import type { Row } from '@/storage/postgres/store-query.ts';
import {
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function sessionJobStateParams(jobState: SessionJobState): unknown[] {
  return [
    jobState.sessionId,
    jobState.workspaceId,
    jobState.badStatusStreak,
    jobState.unknownStreak,
    jobState.endUnconfirmedRuns,
    jobState.endAttemptRuns,
    jobState.inconclusiveRuns,
    jobState.lastFind,
    jobState.statusSince,
    jobState.suspendedAt,
    jobState.suspendedProgressAt,
    jobState.lastReadingAt,
    jobState.lastAttemptAt,
    jobState.usageGrewAt,
    jobState.orphanEnded,
  ];
}

export function parseSessionJobState(row: Row): SessionJobState {
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
    suspendedAt: readNullableTime(row.suspended_at),
    suspendedProgressAt: readNullableTime(row.suspended_progress_at),
    lastReadingAt: readNullableTime(row.last_reading_at),
    lastAttemptAt: readNullableTime(row.last_attempt_at),
    usageGrewAt: readNullableTime(row.usage_grew_at),
    orphanEnded: readBoolean(row, 'orphan_ended'),
  };
}

export function parseAlert(row: Row): AlertRecord {
  const rule = readString(row, 'rule');
  const severity = readString(row, 'severity');
  const groupId = readNullableString(row, 'group_id');

  if (!isAlertRule(rule) || (severity !== 'normal' && severity !== 'critical')) {
    throw unreadable();
  }

  return {
    id: requireAlertId(readString(row, 'id')),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    groupId: groupId === null ? null : requireGroupId(groupId),
    rule,
    targetId: readString(row, 'target_id'),
    severity,
    reason: readNullableString(row, 'reason'),
    openedAt: timeText(row, 'opened_at'),
    lastSeenAt: timeText(row, 'last_seen_at'),
    clearedAt: readNullableTime(row.cleared_at),
    notifiedAt: readNullableTime(row.notified_at),
  };
}

export function alertParams(alert: AlertRecord): unknown[] {
  return [
    alert.id,
    alert.workspaceId,
    alert.groupId,
    alert.rule,
    alert.targetId,
    alert.severity,
    alert.reason,
    alert.openedAt,
    alert.lastSeenAt,
    alert.clearedAt,
    alert.notifiedAt,
  ];
}

export function jobSnapshotExtras(input: {
  oldestQueuedAt: Row[];
  taskActivityAt: Row[];
  relayed: Row[];
  orphanEnded: Row[];
}): Pick<
  JobSnapshot,
  'oldestQueuedAt' | 'taskActivityAt' | 'relayedSessionIds' | 'orphanEndedSessions'
> {
  return {
    oldestQueuedAt: input.oldestQueuedAt.map(row => ({
      connectionId: readString(row, 'connection_id'),
      at: timeText(row, 'at'),
    })),
    taskActivityAt: input.taskActivityAt.map(row => ({
      taskId: readString(row, 'task_id'),
      at: timeText(row, 'at'),
    })),
    relayedSessionIds: input.relayed.map(row => readString(row, 'sender_id')),
    orphanEndedSessions: input.orphanEnded.map(row => ({
      sessionId: readString(row, 'session_id'),
      groupId: readString(row, 'group_id'),
    })),
  };
}

export function timeText(row: Row, key: string): string {
  const value = readNullableTime(row[key]);

  if (value === null) throw unreadable();

  return value;
}
