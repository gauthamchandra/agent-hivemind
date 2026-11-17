import type { UnitOfWork } from '@/ports/storage.ts';
import { parseWorkspace } from '@/storage/postgres/parse-account.ts';
import { groupParams, parseGroup } from '@/storage/postgres/parse-group.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { json, one, oneParsed, run } from '@/storage/postgres/store-query.ts';

export function groupWork(
  sql: Sql
): Pick<UnitOfWork, 'lockGroup' | 'insertGroup' | 'updateGroup' | 'insertNotes' | 'lockWorkspace'> {
  return {
    async lockGroup(workspaceId, id) {
      const row = await one(
        sql,
        'SELECT * FROM groups WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [workspaceId, id]
      );

      return oneParsed(row, parseGroup);
    },
    async insertGroup(group) {
      await run(
        sql,
        `INSERT INTO groups (
           id, workspace_id, name, goal, owner_person_id, default_verification_mode, connection_id,
           budget, spend, caps, session_settings, context_fingerprint, features, initiator, status,
           created_at, closed_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8::numeric, $9::numeric, $10::jsonb, $11::jsonb, $12,
           $13::jsonb, $14, $15, $16::timestamptz, $17::timestamptz
         )`,
        groupParams(group)
      );
    },
    async updateGroup(group) {
      await run(
        sql,
        `UPDATE groups SET
           budget = $3::numeric,
           spend = $4::numeric,
           caps = $5::jsonb,
           status = $6,
           closed_at = $7::timestamptz
         WHERE workspace_id = $1 AND id = $2`,
        [
          group.workspace_id,
          group.id,
          group.budget,
          group.spend,
          json(group.caps),
          group.status,
          group.closed_at,
        ]
      );
    },
    async insertNotes(notes) {
      for (const note of notes) {
        await run(
          sql,
          `INSERT INTO context_notes (workspace_id, group_id, position, name, body)
           VALUES ($1, $2, $3, $4, $5)`,
          [note.workspace_id, note.group_id, note.position, note.name, note.body]
        );
      }
    },
    async lockWorkspace(id) {
      const row = await one(sql, 'SELECT * FROM workspaces WHERE id = $1 FOR UPDATE', [id]);

      return oneParsed(row, parseWorkspace);
    },
  };
}
