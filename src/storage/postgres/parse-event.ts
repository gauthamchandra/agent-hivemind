import { requireEventId, requireGroupId, requireTaskId, requireWorkspaceId } from '@/domain/ids.ts';
import type { EvidenceEntry, TaskEvent } from '@/domain/model.ts';
import { isTaskState } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import {
  isRecord,
  many,
  readJson,
  readNullableString,
  readNumber,
  readScalarRecord,
  readString,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export async function readEvents(
  sql: Sql,
  workspaceId: string,
  groupId: string
): Promise<TaskEvent[]> {
  const rows = await many(
    sql,
    'SELECT * FROM task_events WHERE workspace_id = $1 AND group_id = $2 ORDER BY sequence',
    [workspaceId, groupId]
  );

  return rows.map(parseEvent);
}

export function parseEvent(row: Row): TaskEvent {
  const kind = readString(row, 'kind');
  const actorKind = readString(row, 'actor_kind');
  const from = readNullableString(row, 'from_state');
  const to = readNullableString(row, 'to_state');

  if (
    kind !== 'created' &&
    kind !== 'transition' &&
    kind !== 'verification_mode_changed' &&
    kind !== 'owner_instruction' &&
    kind !== 'note' &&
    kind !== 'session_started' &&
    kind !== 'session_start_failed' &&
    kind !== 'session_ended'
  ) {
    throw unreadable();
  }

  if (actorKind !== 'session' && actorKind !== 'person' && actorKind !== 'service')
    throw unreadable();
  if ((from !== null && !isTaskState(from)) || (to !== null && !isTaskState(to)))
    throw unreadable();

  return {
    id: requireEventId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    task_id: requireTaskId(readString(row, 'task_id')),
    group_id: requireGroupId(readString(row, 'group_id')),
    sequence: readNumber(row, 'sequence'),
    kind,
    actor_kind: actorKind,
    actor_id: readString(row, 'actor_id'),
    from_state: from,
    to_state: to,
    evidence: parseEvidence(readJson(row, 'evidence')),
    note: readNullableString(row, 'note'),
    data: parseData(readJson(row, 'data')),
    at: readTime(row.at),
  };
}

export function parseEvidence(value: unknown): EvidenceEntry[] {
  if (!Array.isArray(value)) throw unreadable();

  return value.map(entry => {
    if (!isRecord(entry)) throw unreadable();

    const kind = entry.kind;

    if (kind !== 'address' && kind !== 'text') throw unreadable();

    return { label: readString(entry, 'label'), kind, value: readString(entry, 'value') };
  });
}

export function parseData(
  value: unknown
): Readonly<Record<string, string | number | boolean | null>> {
  return readScalarRecord(value);
}
