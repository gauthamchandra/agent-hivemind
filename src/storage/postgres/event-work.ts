import type { UnitOfWork } from '@/ports/storage.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { json, run } from '@/storage/postgres/store-query.ts';

export function eventWork(sql: Sql): Pick<UnitOfWork, 'insertEvent'> {
  return {
    async insertEvent(event) {
      await run(
        sql,
        `INSERT INTO task_events (
           id, workspace_id, task_id, group_id, sequence, kind, actor_kind, actor_id,
           from_state, to_state, evidence, note, data, at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, $14::timestamptz
         )`,
        [
          event.id,
          event.workspace_id,
          event.task_id,
          event.group_id,
          event.sequence,
          event.kind,
          event.actor_kind,
          event.actor_id,
          event.from_state,
          event.to_state,
          json(event.evidence),
          event.note,
          json(event.data),
          event.at,
        ]
      );
    },
  };
}
