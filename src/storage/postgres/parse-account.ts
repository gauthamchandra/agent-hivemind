import { requireOperatorKeyId, requirePersonId, requireWorkspaceId } from '@/domain/ids.ts';
import type {
  GroupCaps,
  OperatorKeyRecord,
  Person,
  SessionRole,
  SessionSettings,
  Workspace,
  WorkspaceLimits,
} from '@/domain/model.ts';
import { isOperatorKeyRole, isSessionRole, isWorkspaceRole } from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type { Row } from '@/storage/postgres/store-query.ts';
import {
  isRecord,
  readJson,
  readNullableString,
  readNullableTime,
  readNumber,
  readScalarRecord,
  readString,
  readStringList,
  unreadable,
} from '@/storage/postgres/store-query.ts';

export function parseWorkspace(row: Row): Workspace {
  return {
    id: requireWorkspaceId(readString(row, 'id')),
    name: readString(row, 'name'),
    status: readString(row, 'status') === 'suspended' ? 'suspended' : 'active',
    limits: parseLimits(readJson(row, 'limits')),
    created_at: readTime(row.created_at),
  };
}

export function parsePerson(row: Row): Person {
  const role = readString(row, 'workspace_role');
  const status = readString(row, 'status');

  if (!isWorkspaceRole(role) || (status !== 'active' && status !== 'disabled')) {
    throw unreadable();
  }

  return {
    id: requirePersonId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    display_name: readString(row, 'display_name'),
    workspace_role: role,
    account_id: null,
    status,
    created_at: readTime(row.created_at),
  };
}

export function parseOperatorKey(row: Row): OperatorKeyRecord {
  const role = readString(row, 'role');

  if (!isOperatorKeyRole(role)) throw unreadable();

  const person = readNullableString(row, 'person_id');

  return {
    id: requireOperatorKeyId(readString(row, 'id')),
    workspace_id: requireWorkspaceId(readString(row, 'workspace_id')),
    name: readString(row, 'name'),
    role,
    key_hash: readString(row, 'key_hash'),
    person_id: person === null ? null : requirePersonId(person),
    created_at: readTime(row.created_at),
    expires_at: readNullableTime(row.expires_at),
    revoked_at: readNullableTime(row.revoked_at),
  };
}

export function parseLimits(value: unknown): WorkspaceLimits {
  if (!isRecord(value)) throw unreadable();

  return {
    live_groups: readNumber(value, 'live_groups'),
    live_sessions: readNumber(value, 'live_sessions'),
    groups_per_day: readNumber(value, 'groups_per_day'),
    members_read_all: value.members_read_all === true,
    default_group_caps: parseCaps(value.default_group_caps),
  };
}

export function parseCaps(value: unknown): GroupCaps {
  if (!isRecord(value) || !isRecord(value.live_per_role) || !isRecord(value.live_per_task_role)) {
    throw unreadable();
  }

  return {
    live_sessions: readNumber(value, 'live_sessions'),
    live_per_role: {
      planner: readNumber(value.live_per_role, 'planner'),
      challenger: readNumber(value.live_per_role, 'challenger'),
      implementer: readNumber(value.live_per_role, 'implementer'),
    },
    live_per_task_role: {
      reviewer: readNumber(value.live_per_task_role, 'reviewer'),
      verifier: readNumber(value.live_per_task_role, 'verifier'),
    },
    spawn_rate: readNumber(value, 'spawn_rate'),
    respawns_per_task_role: readNumber(value, 'respawns_per_task_role'),
    total_sessions: readNumber(value, 'total_sessions'),
  };
}

export function parseSettings(value: unknown): SessionSettings {
  if (!isRecord(value)) throw unreadable();

  const tiers = isRecord(value.role_tiers) ? value.role_tiers : {};
  const roleTiers: Partial<Record<SessionRole, string>> = {};

  for (const [key, tier] of Object.entries(tiers)) {
    if (isSessionRole(key) && typeof tier === 'string') roleTiers[key] = tier;
  }

  return {
    model_tier: typeof value.model_tier === 'string' ? value.model_tier : null,
    repositories: readStringList(value.repositories),
    platform_settings: readScalarRecord(value.platform_settings),
    role_tiers: roleTiers,
  };
}
