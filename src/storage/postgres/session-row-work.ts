import type { UnitOfWork } from '@/ports/storage.ts';
import { parseSession, sessionParams } from '@/storage/postgres/session-read.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { one, oneParsed } from '@/storage/postgres/store-query.ts';

export function rowWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'insertSession'
  | 'updateSession'
  | 'lockSession'
  | 'sessionById'
  | 'sessionByTokenHash'
  | 'sessionByEndReceipt'
  | 'touchReport'
> {
  return {
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

      return oneParsed(row, parseSession);
    },
    async sessionById(id) {
      const row = await one(sql, 'SELECT * FROM sessions WHERE id = $1', [id]);

      return oneParsed(row, parseSession);
    },
    async sessionByTokenHash(hash) {
      const row = await one(sql, 'SELECT * FROM sessions WHERE token_hash = $1', [hash]);

      return oneParsed(row, parseSession);
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

      return oneParsed(row, parseSession);
    },
    async touchReport(sessionId, at) {
      await sql.query('UPDATE sessions SET last_report_at = $2::timestamptz WHERE id = $1', [
        sessionId,
        at,
      ]);
    },
  };
}
