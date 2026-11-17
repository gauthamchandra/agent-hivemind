import { canonicalizeDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  requireGroupId,
  requireSessionId,
  requireTaskId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type { SessionRecord } from '@/domain/model.ts';
import { isNeutralStatus, isSessionLife, isSessionRole } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type {
  EnrollmentCodeRecord,
  IdempotencyRecord,
  Occupancy,
  UnitOfWork,
} from '@/ports/storage.ts';

type Sql = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
};

type Row = Record<string, unknown>;

export function sessionUnit(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'occupancy'
  | 'addOccupancy'
  | 'spawnCount'
  | 'insertSpawn'
  | 'holderCount'
  | 'liveOnTask'
  | 'replacementCount'
  | 'nextAttempt'
  | 'implementerEverStarted'
  | 'insertSession'
  | 'updateSession'
  | 'lockSession'
  | 'sessionById'
  | 'sessionByTokenHash'
  | 'sessionByEndReceipt'
  | 'touchReport'
  | 'insertEnrollmentCode'
  | 'enrollmentByHash'
  | 'openEnrollmentCode'
  | 'saveEnrollmentCode'
  | 'voidEnrollmentCodes'
  | 'findIdempotency'
  | 'insertIdempotency'
> {
  return {
    occupancy(workspaceId, groupId) {
      return readOccupancy(sql, workspaceId, groupId);
    },
    async addOccupancy(workspaceId, groupId, delta) {
      await sql.query(
        `UPDATE groups SET
           live_sessions = live_sessions + $3,
           live_planner = live_planner + $4,
           live_challenger = live_challenger + $5,
           live_implementer = live_implementer + $6,
           total_sessions = total_sessions + $7
         WHERE workspace_id = $1 AND id = $2`,
        [
          workspaceId,
          groupId,
          delta.live_sessions,
          delta.planner,
          delta.challenger,
          delta.implementer,
          delta.total_sessions,
        ]
      );
      await sql.query('UPDATE workspaces SET live_sessions = live_sessions + $2 WHERE id = $1', [
        workspaceId,
        delta.live_sessions,
      ]);
    },
    spawnCount(groupId, since) {
      return count(
        sql,
        'SELECT count(*)::int AS count FROM spawn_log WHERE group_id = $1 AND at >= $2::timestamptz',
        [groupId, since]
      );
    },
    async insertSpawn(row) {
      await sql.query(
        `INSERT INTO spawn_log (id, workspace_id, group_id, session_id, at)
         VALUES ($1, $2, $3, $4, $5::timestamptz)`,
        [row.id, row.workspaceId, row.groupId, row.sessionId, row.at]
      );
    },
    holderCount(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life IN ('starting', 'live', 'released')`,
        [taskId, role]
      );
    },
    liveOnTask(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life IN ('starting', 'live')`,
        [taskId, role]
      );
    },
    replacementCount(taskId, role) {
      return count(
        sql,
        `SELECT count(*)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND attempt > 1 AND life <> 'start_failed'`,
        [taskId, role]
      );
    },
    async nextAttempt(taskId, role) {
      const row = await one(
        sql,
        `SELECT COALESCE(MAX(attempt), 0)::int AS count FROM sessions
         WHERE task_id = $1 AND role = $2 AND life <> 'start_failed'`,
        [taskId, role]
      );

      return readNumber(row ?? {}, 'count') + 1;
    },
    async implementerEverStarted(groupId) {
      const row = await one(
        sql,
        `SELECT 1 AS present FROM sessions
         WHERE group_id = $1 AND role = 'implementer' AND life <> 'start_failed'
         LIMIT 1`,
        [groupId]
      );

      return row !== null;
    },
    async insertSession(session) {
      await sql.query(
        `INSERT INTO sessions (
           id, workspace_id, group_id, task_id, role, attempt, parent_session_id,
           platform_session_ref, platform_address, title, life, token_hash, enrolled_at, enrolled_by,
           last_report_at, start_attempt_id, existence_evidence_at, end_requested_at, end_actor_kind,
           end_actor_id, end_reason, end_operation_id, final_usage_pending, last_status, usage,
           attributed_to, secret_delivered, created_at, ended_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz, $14,
           $15::timestamptz, $16, $17::timestamptz, $18::timestamptz, $19, $20, $21, $22, $23, $24,
           $25::numeric, $26, $27, $28::timestamptz, $29::timestamptz
         )`,
        sessionParams(session)
      );
    },
    async updateSession(session) {
      await sql.query(
        `UPDATE sessions SET
           platform_session_ref = $3,
           platform_address = $4,
           life = $5,
           token_hash = $6,
           enrolled_at = $7::timestamptz,
           enrolled_by = $8,
           last_report_at = $9::timestamptz,
           existence_evidence_at = $10::timestamptz,
           end_requested_at = $11::timestamptz,
           end_actor_kind = $12,
           end_actor_id = $13,
           end_reason = $14,
           end_operation_id = $15,
           final_usage_pending = $16,
           last_status = $17,
           usage = $18::numeric,
           attributed_to = $19,
           secret_delivered = $20,
           ended_at = $21::timestamptz
         WHERE workspace_id = $1 AND id = $2`,
        [
          session.workspace_id,
          session.id,
          session.platform_session_ref,
          session.platform_address,
          session.life,
          session.token_hash,
          session.enrolled_at,
          session.enrolled_by,
          session.last_report_at,
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
          session.ended_at,
        ]
      );
    },
    async lockSession(workspaceId, id) {
      const row = await one(
        sql,
        'SELECT * FROM sessions WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [workspaceId, id]
      );

      return row === null ? null : parseSession(row);
    },
    async sessionById(id) {
      const row = await one(sql, 'SELECT * FROM sessions WHERE id = $1', [id]);

      return row === null ? null : parseSession(row);
    },
    async sessionByTokenHash(hash) {
      const row = await one(sql, 'SELECT * FROM sessions WHERE token_hash = $1', [hash]);

      return row === null ? null : parseSession(row);
    },
    async sessionByEndReceipt(hash) {
      const row = await one(
        sql,
        `SELECT s.* FROM idempotency_keys i
         JOIN sessions s ON s.workspace_id = i.workspace_id AND s.id = i.record_id
         WHERE i.caller_kind = 'end_receipt'
           AND i.caller_id = $1
           AND i.route = 'session.end'
           AND i.idempotency_key = 'token'`,
        [hash]
      );

      return row === null ? null : parseSession(row);
    },
    async touchReport(sessionId, at) {
      await sql.query('UPDATE sessions SET last_report_at = $2::timestamptz WHERE id = $1', [
        sessionId,
        at,
      ]);
    },
    async insertEnrollmentCode(code) {
      await sql.query(
        `INSERT INTO enrollment_codes (
           id, workspace_id, session_id, code_hash, expires_at, used_at, attempts, voided_at, created_at
         ) VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::timestamptz, $9::timestamptz)`,
        [
          code.id,
          code.workspace_id,
          code.session_id,
          code.code_hash,
          code.expires_at,
          code.used_at,
          code.attempts,
          code.voided_at,
          code.created_at,
        ]
      );
    },
    async enrollmentByHash(hash) {
      const row = await one(sql, 'SELECT * FROM enrollment_codes WHERE code_hash = $1', [hash]);

      return row === null ? null : parseCode(row);
    },
    async openEnrollmentCode(sessionId) {
      const row = await one(
        sql,
        `SELECT * FROM enrollment_codes
         WHERE session_id = $1 AND used_at IS NULL AND voided_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
        [sessionId]
      );

      return row === null ? null : parseCode(row);
    },
    async saveEnrollmentCode(code) {
      await sql.query(
        `UPDATE enrollment_codes SET
           expires_at = $2::timestamptz,
           used_at = $3::timestamptz,
           attempts = $4,
           voided_at = $5::timestamptz
         WHERE id = $1`,
        [code.id, code.expires_at, code.used_at, code.attempts, code.voided_at]
      );
    },
    async voidEnrollmentCodes(sessionId, at) {
      await sql.query(
        `UPDATE enrollment_codes SET voided_at = $2::timestamptz
         WHERE session_id = $1 AND used_at IS NULL AND voided_at IS NULL`,
        [sessionId, at]
      );
    },
    async findIdempotency(workspaceId, callerKind, callerId, route, key) {
      const row = await one(
        sql,
        `SELECT * FROM idempotency_keys
         WHERE workspace_id = $1 AND caller_kind = $2 AND caller_id = $3 AND route = $4
           AND idempotency_key = $5`,
        [workspaceId, callerKind, callerId, route, key]
      );

      if (row === null) return null;

      return {
        body_hash: readString(row, 'body_hash'),
        record_id: readNullableString(row, 'record_id'),
        completed: readBoolean(row, 'completed'),
        response: readJson(row, 'response'),
      } satisfies IdempotencyRecord;
    },
    async insertIdempotency(row) {
      await sql.query(
        `INSERT INTO idempotency_keys (
           workspace_id, caller_kind, caller_id, route, idempotency_key, body_hash, record_id,
           response, completed, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz)`,
        [
          row.workspaceId,
          row.callerKind,
          row.callerId,
          row.route,
          row.key,
          row.bodyHash,
          row.recordId,
          JSON.stringify(row.response ?? {}),
          row.completed,
          row.at,
        ]
      );
    },
  };
}

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

  return row === null ? null : parseSession(row);
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

function sessionParams(session: SessionRecord): unknown[] {
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

function parseSession(row: Row): SessionRecord {
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
  if (
    endActor !== null &&
    endActor !== 'session' &&
    endActor !== 'person' &&
    endActor !== 'service'
  ) {
    throw unreadable();
  }
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

function parseCode(row: Row): EnrollmentCodeRecord {
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

async function count(sql: Sql, text: string, params: unknown[]): Promise<number> {
  const row = await one(sql, text, params);

  return readNumber(row ?? {}, 'count');
}

async function one(sql: Sql, text: string, params: unknown[]): Promise<Row | null> {
  const rows = await many(sql, text, params);

  return rows[0] ?? null;
}

async function many(sql: Sql, text: string, params: unknown[]): Promise<Row[]> {
  const result = await sql.query<Row>(text, params);

  return result.rows;
}

function readJson(row: Row, key: string): unknown {
  const value = row[key];

  if (typeof value === 'string') return JSON.parse(value);
  if (value === null || value === undefined) return {};

  return value;
}

function readString(row: Row, key: string): string {
  const value = row[key];

  if (typeof value === 'string') return value;

  throw unreadable();
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;

  throw unreadable();
}

function readNumber(row: Row, key: string): number {
  const value = row[key];

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }

  throw unreadable();
}

function readBoolean(row: Row, key: string): boolean {
  const value = row[key];

  if (typeof value === 'boolean') return value;
  if (value === 't' || value === 'true') return true;
  if (value === 'f' || value === 'false') return false;

  throw unreadable();
}

function readNullableTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  return readTime(value);
}

function readNullableMoney(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'string')
    return canonicalizeDecimal(String(value));

  throw unreadable();
}

function unreadable(): HivemindError {
  return new HivemindError('unavailable', 'The database returned a row the service cannot read.');
}
