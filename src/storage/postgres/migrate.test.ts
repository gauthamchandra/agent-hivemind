import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
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
