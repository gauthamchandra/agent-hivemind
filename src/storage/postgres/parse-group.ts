import {
  requireConnectionId,
  requireGroupId,
  requirePersonId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type { Group } from '@/domain/model.ts';
import { isVerificationMode } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import { parseCaps, parseSettings } from '@/storage/postgres/parse-account.ts';
import type { Row } from '@/storage/postgres/store-query.ts';
import {
  json,
  readJson,
  readMoney,
  readNullableString,
  readNullableTime,
  readString,
  readStringList,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function groupParams(group: Group): unknown[] {
  return [
    group.id,
    group.workspace_id,
    group.name,
    group.goal,
    group.owner_person_id,
    group.default_verification_mode,
    group.connection_id,
    group.budget,
    group.spend,
    json(group.caps),
    json(group.session_settings),
    group.context_fingerprint,
    json(group.features),
    group.initiator,
    group.status,
    group.created_at,
    group.closed_at,
  ];
}

export function parseGroup(row: Row): Group {
  const mode = readString(row, 'default_verification_mode');
  const status = readString(row, 'status');

  if (!isVerificationMode(mode) || (status !== 'open' && status !== 'closed')) throw unreadable();

  return {
    id: requireGroupId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    name: readString(row, 'name'),
    goal: readString(row, 'goal'),
    owner_person_id: requirePersonId(readString(row, 'owner_person_id')),
    default_verification_mode: mode,
    connection_id: requireConnectionId(readString(row, 'connection_id')),
    budget: readMoney(row, 'budget'),
    spend: readMoney(row, 'spend'),
    caps: parseCaps(readJson(row, 'caps')),
    session_settings: parseSettings(readJson(row, 'session_settings')),
    context_fingerprint: readString(row, 'context_fingerprint'),
    features: readStringList(readJson(row, 'features')),
    initiator: readNullableString(row, 'initiator'),
    status,
    created_at: readTime(row.created_at),
    closed_at: readNullableTime(row.closed_at),
  };
}
