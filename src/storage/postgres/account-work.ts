import type { UnitOfWork } from '@/ports/storage.ts';
import { parseOperatorKey, parsePerson, parseWorkspace } from '@/storage/postgres/parse-account.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { count, json, many, one, oneParsed, run } from '@/storage/postgres/store-query.ts';

export function accountWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'countWorkspaces'
  | 'countPeople'
  | 'hasUsableOperatorKey'
  | 'insertWorkspace'
  | 'workspace'
  | 'insertPerson'
  | 'people'
  | 'person'
  | 'insertOperatorKey'
  | 'operatorKeyByHash'
> {
  return {
    async countWorkspaces() {
      return count(sql, 'SELECT count(*)::int AS count FROM workspaces');
    },
    async countPeople() {
      return count(sql, 'SELECT count(*)::int AS count FROM people');
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

      return oneParsed(row, parseWorkspace);
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

      return oneParsed(row, parsePerson);
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

      return oneParsed(row, parseOperatorKey);
    },
  };
}
