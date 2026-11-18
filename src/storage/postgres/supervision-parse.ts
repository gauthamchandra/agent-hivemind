import { requireSessionId, requireWorkspaceId } from '@/domain/ids.ts';
import type { SessionWatch } from '@/domain/supervision.ts';
import { readBoolean } from '@/storage/postgres/session-read.ts';
import type { Row } from '@/storage/postgres/store-query.ts';
import {
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function watchParams(watch: SessionWatch): unknown[] {
  return [
    watch.sessionId,
    watch.workspaceId,
    watch.unknownStreak,
    watch.endUnconfirmedRuns,
    watch.endAttemptRuns,
    watch.inconclusiveRuns,
    watch.lastFind,
    watch.suspendedAt,
    watch.suspendedProgressAt,
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
    unknownStreak: readNumber(row, 'unknown_streak'),
    endUnconfirmedRuns: readNumber(row, 'end_unconfirmed_runs'),
    endAttemptRuns: readNumber(row, 'end_attempt_runs'),
    inconclusiveRuns: readNumber(row, 'inconclusive_runs'),
    lastFind,
    suspendedAt: readNullableTime(row.suspended_at),
    suspendedProgressAt: readNullableTime(row.suspended_progress_at),
    orphanEnded: readBoolean(row, 'orphan_ended'),
  };
}
