import {
  requireChangesetId,
  requireGroupId,
  requireTaskId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type { Task } from '@/domain/model.ts';
import { isActorKind, isTaskState, isVerificationMode } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import {
  json,
  many,
  readJson,
  readNullableString,
  readNullableTime,
  readNumber,
  readString,
  readStringList,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function taskWrite(kind: 'INSERT' | 'UPDATE'): string {
  if (kind === 'INSERT') {
    return `INSERT INTO tasks (
      id, workspace_id, group_id, parent_id, title, description, state, state_entered_at,
      verification_mode, changeset_id, depends_on, changeset_round, respawns_used,
      created_by_kind, created_by_id, created_at, closed_at, version
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10, $11::jsonb, $12, $13, $14, $15,
      $16::timestamptz, $17::timestamptz, $18
    )`;
  }

  return `UPDATE tasks SET
    title = $3,
    description = $4,
    state = $5,
    state_entered_at = $6::timestamptz,
    verification_mode = $7,
    changeset_id = $8,
    changeset_round = $9,
    closed_at = $10::timestamptz,
    version = $11
  WHERE workspace_id = $1 AND id = $2`;
}

export function taskParams(task: Task): unknown[] {
  return [
    task.id,
    task.workspace_id,
    task.group_id,
    task.parent_id,
    task.title,
    task.description,
    task.state,
    task.state_entered_at,
    task.verification_mode,
    task.changeset_id,
    json(task.depends_on),
    task.changeset_round,
    task.respawns_used,
    task.created_by_kind,
    task.created_by_id,
    task.created_at,
    task.closed_at,
    task.version,
  ];
}

export async function readTasks(sql: Sql, workspaceId: string, groupId: string): Promise<Task[]> {
  const rows = await many(
    sql,
    'SELECT * FROM tasks WHERE workspace_id = $1 AND group_id = $2 ORDER BY created_at, id',
    [workspaceId, groupId]
  );

  return rows.map(parseTask);
}

export function parseTask(row: Row): Task {
  const state = readString(row, 'state');
  const mode = readString(row, 'verification_mode');
  const createdBy = readString(row, 'created_by_kind');
  const parent = readNullableString(row, 'parent_id');

  if (!isTaskState(state) || !isVerificationMode(mode)) throw unreadable();
  if (!isActorKind(createdBy)) throw unreadable();

  return {
    id: requireTaskId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    parent_id: parent === null ? null : requireTaskId(parent),
    title: readString(row, 'title'),
    description: readString(row, 'description'),
    state,
    state_entered_at: readTime(row.state_entered_at),
    verification_mode: mode,
    changeset_id: readChangeset(row),
    depends_on: readStringList(readJson(row, 'depends_on')).map(requireTaskId),
    changeset_round: readNumber(row, 'changeset_round'),
    respawns_used: readNumber(row, 'respawns_used'),
    created_by_kind: createdBy,
    created_by_id: readString(row, 'created_by_id'),
    created_at: readTime(row.created_at),
    closed_at: readNullableTime(row.closed_at),
    version: readNumber(row, 'version'),
  };
}

export function readChangeset(row: Row): Task['changeset_id'] {
  const value = readNullableString(row, 'changeset_id');

  return value === null ? null : requireChangesetId(value);
}
