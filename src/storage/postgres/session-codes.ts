import type { IdempotencyRecord, UnitOfWork } from '@/ports/storage.ts';
import { parseCode, readBoolean } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { one, readJson, readNullableString, readString } from '@/storage/postgres/store-query.ts';

export function codeWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'insertEnrollmentCode'
  | 'enrollmentByHash'
  | 'openEnrollmentCode'
  | 'saveEnrollmentCode'
  | 'voidEnrollmentCodes'
  | 'findIdempotency'
  | 'insertIdempotency'
> {
  return {
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
