import type { SessionJobState } from '@/domain/background-jobs.ts';
import { requireSessionId, requireWorkspaceId } from '@/domain/ids.ts';
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
    jobState.unknownStreak,
    jobState.endUnconfirmedRuns,
    jobState.endAttemptRuns,
    jobState.inconclusiveRuns,
    jobState.lastFind,
    jobState.suspendedAt,
    jobState.suspendedProgressAt,
    jobState.lastReadingAt,
    jobState.lastAttemptAt,
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
    unknownStreak: readNumber(row, 'unknown_streak'),
    endUnconfirmedRuns: readNumber(row, 'end_unconfirmed_runs'),
    endAttemptRuns: readNumber(row, 'end_attempt_runs'),
    inconclusiveRuns: readNumber(row, 'inconclusive_runs'),
    lastFind,
    suspendedAt: readNullableTime(row.suspended_at),
    suspendedProgressAt: readNullableTime(row.suspended_progress_at),
    lastReadingAt: readNullableTime(row.last_reading_at),
    lastAttemptAt: readNullableTime(row.last_attempt_at),
    orphanEnded: readBoolean(row, 'orphan_ended'),
  };
}
