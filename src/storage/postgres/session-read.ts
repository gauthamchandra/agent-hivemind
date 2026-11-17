import { canonicalizeDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  requireGroupId,
  requireSessionId,
  requireTaskId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isActorKind, isNeutralStatus, isSessionLife, isSessionRole } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type { EnrollmentCodeRecord, Occupancy } from '@/ports/storage.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import {
  many,
  one,
  oneParsed,
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export async function readSessions(
  sql: Sql,
  workspaceId: string,
  groupId: string
): Promise<SessionRecord[]> {
  const rows = await many(
    sql,
    'SELECT * FROM sessions WHERE workspace_id = $1 AND group_id = $2 ORDER BY created_at, id',
    [workspaceId, groupId]
  );

  return rows.map(parseSession);
}

export async function readSession(
  sql: Sql,
  workspaceId: string,
  id: string
): Promise<SessionRecord | null> {
  const row = await one(sql, 'SELECT * FROM sessions WHERE workspace_id = $1 AND id = $2', [
    workspaceId,
    id,
  ]);

  return oneParsed(row, parseSession);
}

export function readOccupancy(sql: Sql, workspaceId: string, groupId: string): Promise<Occupancy> {
  return one(
    sql,
    `SELECT g.live_sessions, g.live_planner, g.live_challenger, g.live_implementer, g.total_sessions,
            w.live_sessions AS workspace_live_sessions
     FROM groups g
     JOIN workspaces w ON w.id = g.workspace_id
     WHERE g.workspace_id = $1 AND g.id = $2`,
    [workspaceId, groupId]
  ).then(row => {
    if (row === null) {
      throw new HivemindError('not_found', 'No group with that identifier is in this workspace.');
    }

    return {
      live_sessions: readNumber(row, 'live_sessions'),
      planner: readNumber(row, 'live_planner'),
      challenger: readNumber(row, 'live_challenger'),
      implementer: readNumber(row, 'live_implementer'),
      total_sessions: readNumber(row, 'total_sessions'),
      workspace_live_sessions: readNumber(row, 'workspace_live_sessions'),
    };
  });
}

export function sessionParams(session: SessionRecord): unknown[] {
  return [
    session.id,
    session.workspace_id,
    session.group_id,
    session.task_id,
    session.role,
    session.attempt,
    session.parent_session_id,
    session.platform_session_ref,
    session.platform_address,
    session.title,
    session.life,
    session.token_hash,
    session.enrolled_at,
    session.enrolled_by,
    session.last_report_at,
    session.start_attempt_id,
    session.existence_evidence_at,
    session.end_requested_at,
    session.end_actor_kind,
    session.end_actor_id,
    session.end_reason,
    session.end_operation_id,
    session.final_usage_pending,
    session.last_status,
    session.usage,
    session.attributed_to,
    session.secret_delivered,
    session.created_at,
    session.ended_at,
  ];
}

export function parseSession(row: Row): SessionRecord {
  const role = readString(row, 'role');
  const life = readString(row, 'life');
  const enrolledBy = readNullableString(row, 'enrolled_by');
  const endActor = readNullableString(row, 'end_actor_kind');
  const status = readNullableString(row, 'last_status');
  const attributed = readNullableString(row, 'attributed_to');
  const delivered = readNullableString(row, 'secret_delivered');
  const parent = readNullableString(row, 'parent_session_id');

  if (!isSessionRole(role) || !isSessionLife(life)) throw unreadable();
  if (enrolledBy !== null && enrolledBy !== 'secret' && enrolledBy !== 'code') throw unreadable();
  if (endActor !== null && !isActorKind(endActor)) throw unreadable();
  if (status !== null && !isNeutralStatus(status)) throw unreadable();
  if (attributed !== null && attributed !== 'owner' && attributed !== 'service') throw unreadable();
  if (delivered !== null && delivered !== 'yes' && delivered !== 'no' && delivered !== 'unknown') {
    throw unreadable();
  }

  return {
    id: requireSessionId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    task_id: requireTaskId(readString(row, 'task_id')),
    role,
    attempt: readNumber(row, 'attempt'),
    parent_session_id: parent === null ? null : requireSessionId(parent),
    platform_session_ref: readNullableString(row, 'platform_session_ref'),
    platform_address: readNullableString(row, 'platform_address'),
    title: readString(row, 'title'),
    life,
    token_hash: readNullableString(row, 'token_hash'),
    enrolled_at: readNullableTime(row.enrolled_at),
    enrolled_by: enrolledBy,
    last_report_at: readNullableTime(row.last_report_at),
    start_attempt_id: readString(row, 'start_attempt_id'),
    existence_evidence_at: readNullableTime(row.existence_evidence_at),
    end_requested_at: readNullableTime(row.end_requested_at),
    end_actor_kind: endActor,
    end_actor_id: readNullableString(row, 'end_actor_id'),
    end_reason: readNullableString(row, 'end_reason'),
    end_operation_id: readNullableString(row, 'end_operation_id'),
    final_usage_pending: readBoolean(row, 'final_usage_pending'),
    last_status: status,
    usage: readNullableMoney(row, 'usage'),
    attributed_to: attributed,
    secret_delivered: delivered,
    created_at: readTime(row.created_at),
    ended_at: readNullableTime(row.ended_at),
  };
}

export function parseCode(row: Row): EnrollmentCodeRecord {
  return {
    id: readString(row, 'id'),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    session_id: requireSessionId(readString(row, 'session_id')),
    code_hash: readString(row, 'code_hash'),
    expires_at: readNullableTime(row.expires_at),
    used_at: readNullableTime(row.used_at),
    attempts: readNumber(row, 'attempts'),
    voided_at: readNullableTime(row.voided_at),
    created_at: readTime(row.created_at),
  };
}

export function readBoolean(row: Row, key: string): boolean {
  const value = row[key];

  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;

  throw unreadable();
}

export function readNullableMoney(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string')
    return canonicalizeDecimal(String(value));

  throw unreadable();
}
