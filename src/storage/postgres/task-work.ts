import type { UnitOfWork } from '@/ports/storage.ts';
import { parseTask, readTasks, taskParams, taskWrite } from '@/storage/postgres/parse-task.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { json, many, one, oneParsed, readNumber, run } from '@/storage/postgres/store-query.ts';

export function taskWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'insertTask'
  | 'updateTask'
  | 'lockTask'
  | 'tasks'
  | 'childCounts'
  | 'openChildren'
  | 'nextSequence'
  | 'insertEvent'
> {
  return {
    async insertTask(task) {
      await run(sql, taskWrite('INSERT'), taskParams(task));
    },
    async updateTask(task) {
      await run(sql, taskWrite('UPDATE'), [
        task.workspace_id,
        task.id,
        task.title,
        task.description,
        task.state,
        task.state_entered_at,
        task.verification_mode,
        task.changeset_id,
        task.changeset_round,
        task.closed_at,
        task.version,
      ]);
    },
    async lockTask(workspaceId, id) {
      const row = await one(
        sql,
        'SELECT * FROM tasks WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [workspaceId, id]
      );

      return oneParsed(row, parseTask);
    },
    tasks(workspaceId, groupId) {
      return readTasks(sql, workspaceId, groupId);
    },
    async childCounts(workspaceId, groupId) {
      const row = await one(
        sql,
        `SELECT
           count(*)::int AS child_count,
           count(*) FILTER (WHERE state NOT IN ('done', 'failed'))::int AS open_child_count,
           count(*) FILTER (WHERE state = 'failed')::int AS failed_child_count
         FROM tasks
         WHERE workspace_id = $1 AND group_id = $2 AND parent_id IS NOT NULL`,
        [workspaceId, groupId]
      );

      return {
        childCount: readNumber(row ?? {}, 'child_count'),
        openChildCount: readNumber(row ?? {}, 'open_child_count'),
        failedChildCount: readNumber(row ?? {}, 'failed_child_count'),
      };
    },
    async openChildren(workspaceId, groupId, parentId) {
      const rows = await many(
        sql,
        `SELECT * FROM tasks
         WHERE workspace_id = $1 AND group_id = $2 AND parent_id = $3
           AND state NOT IN ('done', 'failed')
         ORDER BY created_at, id
         FOR UPDATE`,
        [workspaceId, groupId, parentId]
      );

      return rows.map(parseTask);
    },
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
    async nextSequence(groupId) {
      const row = await one(
        sql,
        'SELECT (COALESCE(MAX(sequence), 0) + 1)::int AS next FROM task_events WHERE group_id = $1',
        [groupId]
      );

      return readNumber(row ?? {}, 'next');
    },
  };
}
