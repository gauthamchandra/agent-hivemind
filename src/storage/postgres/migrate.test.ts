import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyMigrations,
  type ExecuteSql,
  executePglite,
  executePostgres,
} from '@/storage/postgres/migrate.ts';
import { openEmptyDatabase } from '@/testing/pglite.ts';

async function appliedNames(db: PGlite): Promise<string[]> {
  const result = await db.query<{ name: string }>(
    'SELECT name FROM schema_migrations ORDER BY name'
  );

  return result.rows.map(row => row.name);
}

async function publicTable(db: PGlite, table: string): Promise<number> {
  const result = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );

  return result.rows[0]?.count ?? 0;
}

async function migrationFiles(): Promise<string[]> {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));

  return (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
}

async function expectAppliedOnce(execute: (db: PGlite) => ExecuteSql): Promise<void> {
  const db = await openEmptyDatabase();
  const run = execute(db);
  const files = await migrationFiles();

  await applyMigrations(run);

  expect(await appliedNames(db)).toEqual(files);
  expect(await publicTable(db, 'workspaces')).toBe(1);
  expect(await publicTable(db, 'migrations')).toBe(0);

  const drizzle = await db.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM information_schema.schemata
     WHERE schema_name = 'drizzle'`
  );

  expect(drizzle.rows[0]?.count).toBe(0);

  await applyMigrations(run);

  expect(await appliedNames(db)).toEqual(files);

  const workspaces = await db.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM workspaces'
  );

  expect(workspaces.rows[0]?.count).toBe(0);

  const spawn = await db.query<{ name: string }>(
    `SELECT indexname AS name FROM pg_indexes
     WHERE tablename = 'spawn_log' AND indexname = 'spawn_log_group_at'`
  );

  expect(spawn.rows).toHaveLength(1);
}

test('an unfinished stop stays pending when the column is added', async () => {
  const db = await openEmptyDatabase();
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();

  for (const name of files) {
    if (name === '009_platform_stop_pending.sql') continue;

    await db.exec(await readFile(join(directory, name), 'utf8'));
  }

  await db.exec(
    `INSERT INTO workspaces (id, name, status, limits, created_at)
     VALUES ('ws_default', 'Local', 'active', '{}', '2026-01-01T00:00:00Z');
     INSERT INTO people (id, workspace_id, display_name, workspace_role, account_id, status, created_at)
     VALUES ('per_01', 'ws_default', 'Ada', 'administrator', NULL, 'active', '2026-01-01T00:00:00Z');
     INSERT INTO groups (
       id, workspace_id, name, goal, owner_person_id, default_verification_mode, connection_id,
       budget, spend, caps, session_settings, context_fingerprint, features, status, created_at
     ) VALUES (
       'grp_01', 'ws_default', 'Checkout', 'Ship it.', 'per_01', 'before_merge', 'con_01',
       10, 0, '{}', '{}', 'fp', '{}', 'open', '2026-01-01T00:00:00Z'
     );
     INSERT INTO tasks (
       id, workspace_id, group_id, parent_id, title, description, state, state_entered_at,
       verification_mode, depends_on, changeset_round, respawns_used, created_by_kind, created_by_id,
       created_at, version
     ) VALUES (
       'tsk_01', 'ws_default', 'grp_01', NULL, 'Root', 'The root task.', 'implementing',
       '2026-01-01T00:00:00Z', 'before_merge', '[]', 1, 0, 'person', 'per_01',
       '2026-01-01T00:00:00Z', 1
     );
     INSERT INTO sessions (
       id, workspace_id, group_id, task_id, role, attempt, title, life, start_attempt_id,
       platform_session_ref, final_usage_pending, created_at
     ) VALUES
       ('ses_stop', 'ws_default', 'grp_01', 'tsk_01', 'planner', 1, 'Pending stop', 'ended',
        'attempt-stop', 'plat_stop', true, '2026-01-01T00:00:00Z'),
       ('ses_failed', 'ws_default', 'grp_01', 'tsk_01', 'implementer', 1, 'Failed start',
        'start_failed', 'attempt-failed', 'plat_failed', true, '2026-01-01T00:00:01Z'),
       ('ses_clear', 'ws_default', 'grp_01', 'tsk_01', 'reviewer', 1, 'Already clear', 'ended',
        'attempt-clear', 'plat_clear', false, '2026-01-01T00:00:02Z'),
       ('ses_noref', 'ws_default', 'grp_01', 'tsk_01', 'verifier', 1, 'No reference', 'ended',
        'attempt-noref', NULL, true, '2026-01-01T00:00:03Z');`
  );
  await db.exec(await readFile(join(directory, '009_platform_stop_pending.sql'), 'utf8'));

  const rows = await db.query<{ id: string; platform_stop_pending: boolean }>(
    'SELECT id, platform_stop_pending FROM sessions ORDER BY id'
  );
  const pending = Object.fromEntries(rows.rows.map(row => [row.id, row.platform_stop_pending]));

  expect(pending.ses_stop).toBe(true);
  expect(pending.ses_failed).toBe(true);
  expect(pending.ses_clear).toBe(false);
  expect(pending.ses_noref).toBe(false);
});

test('a timestamp column is named with _at or _until', async () => {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql'));
  const offenders: string[] = [];

  for (const name of files) {
    const text = await readFile(join(directory, name), 'utf8');

    for (const match of text.matchAll(/^\s*([a-z_]+)\s+timestamptz\b/gm)) {
      const column = match[1];

      // `at` is the event time already shipped in the first migrations.
      if (column === undefined || column === 'at') continue;
      if (column.endsWith('_at') || column.endsWith('_until')) continue;

      offenders.push(`${name}: ${column}`);
    }
  }

  expect(offenders).toEqual([]);
});

describe('sql migrations', () => {
  test('pglite exec applies the ordered files once', () => expectAppliedOnce(executePglite));

  test('a postgres query result applies the same files once', () =>
    expectAppliedOnce(db =>
      executePostgres(async sql => {
        const results = await db.exec(sql);

        return results.at(-1) ?? { rows: [] };
      })
    ));
});
