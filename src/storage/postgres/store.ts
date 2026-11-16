import type { PGlite, Transaction } from '@electric-sql/pglite';
import { canonicalizeDecimal } from '@/domain/decimal.ts';
import { HivemindError } from '@/domain/errors.ts';
import {
  requireConnectionId,
  requireEventId,
  requireGroupId,
  requireOperatorKeyId,
  requirePersonId,
  requireTaskId,
  requireWorkspaceId,
} from '@/domain/ids.ts';
import type {
  EvidenceEntry,
  Group,
  GroupCaps,
  OperatorKeyRecord,
  Person,
  SessionRole,
  SessionSettings,
  Task,
  TaskEvent,
  Workspace,
  WorkspaceLimits,
} from '@/domain/model.ts';
import {
  isOperatorKeyRole,
  isSessionRole,
  isTaskState,
  isVerificationMode,
  isWorkspaceRole,
} from '@/domain/model.ts';
import { readTime } from '@/domain/time.ts';
import type { Store, UnitOfWork } from '@/ports/storage.ts';
import { applyMigrations, executePglite } from '@/storage/postgres/migrate.ts';

type Sql = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(text: string): Promise<unknown>;
};

type Row = Record<string, unknown>;

export function openPgliteStore(db: PGlite): Store {
  return {
    async migrate() {
      await db.waitReady;
      await applyMigrations(executePglite(db));
    },

    transact(work) {
      return db.transaction(tx => work(unitOfWork(queries(tx))));
    },

    async group(workspaceId, groupId) {
      const row = await one(
        queries(db),
        'SELECT * FROM groups WHERE workspace_id = $1 AND id = $2',
        [workspaceId, groupId]
      );

      return row === null ? null : parseGroup(row);
    },

    tasks(workspaceId, groupId) {
      return readTasks(queries(db), workspaceId, groupId);
    },

    events(workspaceId, groupId) {
      return readEvents(queries(db), workspaceId, groupId);
    },
  };
}

function queries(db: PGlite | Transaction): Sql {
  return {
    query(text, params) {
      return db.query(text, params);
    },
    exec(text) {
      return db.exec(text);
    },
  };
}

function unitOfWork(sql: Sql): UnitOfWork {
  return {
    async countWorkspaces() {
      return readCount(sql, 'SELECT count(*)::int AS count FROM workspaces');
    },
    async countPeople() {
      return readCount(sql, 'SELECT count(*)::int AS count FROM people');
    },
    async hasUsableOperatorKey(now) {
      const row = await one(
        sql,
        `SELECT 1 AS present
         FROM operator_keys
         WHERE revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > $1::timestamptz)
         LIMIT 1`,
        [now]
      );

      return row !== null;
    },
    async insertWorkspace(workspace) {
      await run(
        sql,
        `INSERT INTO workspaces (id, name, status, limits, created_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [
          workspace.id,
          workspace.name,
          workspace.status,
          json(workspace.limits),
          workspace.created_at,
        ]
      );
    },
    async workspace(id) {
      const row = await one(sql, 'SELECT * FROM workspaces WHERE id = $1', [id]);

      return row === null ? null : parseWorkspace(row);
    },
    async insertPerson(person) {
      await run(
        sql,
        `INSERT INTO people (
           id, workspace_id, display_name, workspace_role, account_id, status, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
        [
          person.id,
          person.workspace_id,
          person.display_name,
          person.workspace_role,
          person.account_id,
          person.status,
          person.created_at,
        ]
      );
    },
    async people(workspaceId) {
      const rows = await many(
        sql,
        'SELECT * FROM people WHERE workspace_id = $1 ORDER BY created_at, id',
        [workspaceId]
      );

      return rows.map(parsePerson);
    },
    async person(workspaceId, id) {
      const row = await one(sql, 'SELECT * FROM people WHERE workspace_id = $1 AND id = $2', [
        workspaceId,
        id,
      ]);

      return row === null ? null : parsePerson(row);
    },
    async insertOperatorKey(record) {
      await run(
        sql,
        `INSERT INTO operator_keys (
           id, workspace_id, name, role, key_hash, person_id, created_at, expires_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)`,
        [
          record.id,
          record.workspace_id,
          record.name,
          record.role,
          record.key_hash,
          record.person_id,
          record.created_at,
          record.expires_at,
          record.revoked_at,
        ]
      );
    },
    async operatorKeyByHash(hash) {
      const row = await one(sql, 'SELECT * FROM operator_keys WHERE key_hash = $1', [hash]);

      return row === null ? null : parseOperatorKey(row);
    },
    async lockGroup(workspaceId, id) {
      const row = await one(
        sql,
        'SELECT * FROM groups WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
        [workspaceId, id]
      );

      return row === null ? null : parseGroup(row);
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
    async insertTask(task) {
      await run(sql, taskWrite('INSERT'), taskParams(task));
    },
    async updateTask(task) {
      await run(sql, taskWrite('UPDATE'), [
        task.workspace_id,
        task.id,
        task.state,
        task.state_entered_at,
        task.verification_mode,
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

      return row === null ? null : parseTask(row);
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
    async nextSequence(groupId) {
      const row = await one(
        sql,
        'SELECT (COALESCE(MAX(sequence), 0) + 1)::int AS next FROM task_events WHERE group_id = $1',
        [groupId]
      );

      return readNumber(row ?? {}, 'next');
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
  };
}

function taskWrite(kind: 'INSERT' | 'UPDATE'): string {
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
    state = $3,
    state_entered_at = $4::timestamptz,
    verification_mode = $5,
    changeset_round = $6,
    closed_at = $7::timestamptz,
    version = $8
  WHERE workspace_id = $1 AND id = $2`;
}

function taskParams(task: Task): unknown[] {
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

function groupParams(group: Group): unknown[] {
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

async function readTasks(sql: Sql, workspaceId: string, groupId: string): Promise<Task[]> {
  const rows = await many(
    sql,
    'SELECT * FROM tasks WHERE workspace_id = $1 AND group_id = $2 ORDER BY created_at, id',
    [workspaceId, groupId]
  );

  return rows.map(parseTask);
}

async function readEvents(sql: Sql, workspaceId: string, groupId: string): Promise<TaskEvent[]> {
  const rows = await many(
    sql,
    'SELECT * FROM task_events WHERE workspace_id = $1 AND group_id = $2 ORDER BY sequence',
    [workspaceId, groupId]
  );

  return rows.map(parseEvent);
}

async function run(sql: Sql, text: string, params: unknown[]): Promise<void> {
  await sql.query(text, params);
}

async function one(sql: Sql, text: string, params: unknown[]): Promise<Row | null> {
  const rows = await many(sql, text, params);
  const row = rows[0];

  if (row === undefined) return null;
  if (rows.length > 1) {
    throw new HivemindError('unavailable', 'The query returned more than one row.');
  }

  return row;
}

async function many(sql: Sql, text: string, params: unknown[]): Promise<Row[]> {
  const result = await sql.query<Row>(text, params);

  return result.rows;
}

async function readCount(sql: Sql, text: string): Promise<number> {
  const row = await one(sql, text, []);

  return readNumber(row ?? {}, 'count');
}

function parseWorkspace(row: Row): Workspace {
  return {
    id: requireWorkspaceId(readString(row, 'id')),
    name: readString(row, 'name'),
    status: readString(row, 'status') === 'suspended' ? 'suspended' : 'active',
    limits: parseLimits(readJson(row, 'limits')),
    created_at: readTime(row.created_at),
  };
}

function parsePerson(row: Row): Person {
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

function parseOperatorKey(row: Row): OperatorKeyRecord {
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

function parseGroup(row: Row): Group {
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

function parseTask(row: Row): Task {
  const state = readString(row, 'state');
  const mode = readString(row, 'verification_mode');
  const createdBy = readString(row, 'created_by_kind');
  const parent = readNullableString(row, 'parent_id');

  if (!isTaskState(state) || !isVerificationMode(mode)) throw unreadable();
  if (createdBy !== 'session' && createdBy !== 'person' && createdBy !== 'service')
    throw unreadable();

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
    changeset_id: null,
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

function parseEvent(row: Row): TaskEvent {
  const kind = readString(row, 'kind');
  const actorKind = readString(row, 'actor_kind');
  const from = readNullableString(row, 'from_state');
  const to = readNullableString(row, 'to_state');

  if (
    kind !== 'created' &&
    kind !== 'transition' &&
    kind !== 'verification_mode_changed' &&
    kind !== 'owner_instruction'
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

function parseLimits(value: unknown): WorkspaceLimits {
  if (!isRecord(value)) throw unreadable();

  return {
    live_groups: readNumber(value, 'live_groups'),
    live_sessions: readNumber(value, 'live_sessions'),
    groups_per_day: readNumber(value, 'groups_per_day'),
    members_read_all: value.members_read_all === true,
    default_group_caps: parseCaps(value.default_group_caps),
  };
}

function parseCaps(value: unknown): GroupCaps {
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

function parseSettings(value: unknown): SessionSettings {
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

function parseEvidence(value: unknown): EvidenceEntry[] {
  if (!Array.isArray(value)) throw unreadable();

  return value.map(entry => {
    if (!isRecord(entry)) throw unreadable();

    const kind = entry.kind;

    if (kind !== 'address' && kind !== 'text') throw unreadable();

    return { label: readString(entry, 'label'), kind, value: readString(entry, 'value') };
  });
}

function parseData(value: unknown): Readonly<Record<string, string | number | boolean | null>> {
  return readScalarRecord(value);
}

function readScalarRecord(value: unknown): Record<string, string | number | boolean | null> {
  if (!isRecord(value)) throw unreadable();

  const data: Record<string, string | number | boolean | null> = {};

  for (const [key, item] of Object.entries(value)) {
    if (
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      item === null
    ) {
      data[key] = item;
      continue;
    }

    throw unreadable();
  }

  return data;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw unreadable();

  return value;
}

function readString(row: Row, key: string): string {
  const value = row[key];

  if (typeof value !== 'string') throw unreadable();

  return value;
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];

  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw unreadable();

  return value;
}

function readNullableTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  return readTime(value);
}

function readNumber(row: Row, key: string): number {
  const value = row[key];

  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);

  throw unreadable();
}

function readMoney(row: Row, key: string): string {
  const value = row[key];

  if (typeof value === 'number' || typeof value === 'string')
    return canonicalizeDecimal(String(value));

  throw unreadable();
}

function readJson(row: Row, key: string): unknown {
  const value = row[key];

  if (typeof value === 'string') return JSON.parse(value);

  return value;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unreadable(): HivemindError {
  return new HivemindError('unavailable', 'The database returned a row the service cannot read.');
}
