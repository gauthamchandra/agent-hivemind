import { describe, expect, test } from 'bun:test';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import {
  applyMigrations,
  type ExecuteSql,
  executePglite,
  executePostgres,
  statementsOfNoTransactionFile,
} from '@/storage/postgres/migrate.ts';
import { createTemporaryDirectory } from '@/testing/files.ts';
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

const tableMigration =
  'CREATE TABLE a (n int);\n--> statement-breakpoint\nCREATE TABLE b (n int);\n';

const concurrentIndexes = [
  'DROP INDEX CONCURRENTLY IF EXISTS a_n;',
  'CREATE INDEX CONCURRENTLY a_n ON a (n);',
  'DROP INDEX CONCURRENTLY IF EXISTS b_n;',
  'CREATE INDEX CONCURRENTLY b_n ON b (n);',
];

const concurrentIndexMigration = `${concurrentIndexes.join('\n--> statement-breakpoint\n')}\n`;

async function migrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await createTemporaryDirectory('hivemind-migrations-');

  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(directory, name), text);
  }

  return directory;
}

function postgresStyle(db: PGlite): ExecuteSql {
  return executePostgres(async sql => {
    const results = await db.exec(sql);

    return results.at(-1) ?? { rows: [] };
  });
}

test.each([
  ['pglite exec', executePglite],
  ['a postgres query', postgresStyle],
])('a no-transaction file builds its indexes concurrently through %s', async (_label, execute) => {
  const db = await openEmptyDatabase();
  const directory = await migrationDirectory({
    '001_tables.sql': tableMigration,
    '002_indexes.no-transaction.sql': concurrentIndexMigration,
  });

  await applyMigrations(execute(db), directory);

  const indexes = await db.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
     FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname IN ('a_n', 'b_n') ORDER BY 1`
  );

  expect(indexes.rows).toEqual([
    { name: 'a_n', valid: true },
    { name: 'b_n', valid: true },
  ]);
  expect(await appliedNames(db)).toEqual(['001_tables.sql', '002_indexes.no-transaction.sql']);
});

test('a no-transaction file runs one statement per call and any other file runs as one script', async () => {
  const db = await openEmptyDatabase();
  const directory = await migrationDirectory({
    '001_tables.sql': tableMigration,
    '002_indexes.no-transaction.sql': concurrentIndexMigration,
  });
  const calls: string[] = [];
  const run = executePglite(db);

  await applyMigrations(sql => {
    calls.push(sql);

    return run(sql);
  }, directory);

  expect(calls.filter(sql => !sql.includes('schema_migrations'))).toEqual([
    tableMigration,
    ...concurrentIndexes,
  ]);
});

test('a concurrent index in a file that is not marked no-transaction is refused', async () => {
  const db = await openEmptyDatabase();
  const directory = await migrationDirectory({
    '001_tables.sql': tableMigration,
    '002_indexes.sql': concurrentIndexMigration,
  });

  await expect(applyMigrations(executePglite(db), directory)).rejects.toThrow(
    'CONCURRENTLY cannot run inside a transaction block'
  );
  expect(await appliedNames(db)).toEqual(['001_tables.sql']);
});

test('a no-transaction file that failed halfway runs again from its first statement', async () => {
  const db = await openEmptyDatabase();
  const directory = await migrationDirectory({
    '001_tables.sql': 'CREATE TABLE a (n int);\nINSERT INTO a VALUES (1), (1);\n',
    '002_indexes.no-transaction.sql': [
      'DROP INDEX CONCURRENTLY IF EXISTS a_n;',
      'CREATE UNIQUE INDEX CONCURRENTLY a_n ON a (n);',
    ].join('\n--> statement-breakpoint\n'),
  });
  const indexValidity = () =>
    db.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = 'a_n'`
    );

  await expect(applyMigrations(executePglite(db), directory)).rejects.toThrow();
  expect((await indexValidity()).rows).toEqual([{ valid: false }]);
  expect(await appliedNames(db)).toEqual(['001_tables.sql']);

  await db.exec('DELETE FROM a WHERE ctid IN (SELECT ctid FROM a LIMIT 1)');
  await applyMigrations(executePglite(db), directory);

  expect((await indexValidity()).rows).toEqual([{ valid: true }]);
  expect(await appliedNames(db)).toEqual(['001_tables.sql', '002_indexes.no-transaction.sql']);
});

test('the statements of a no-transaction file are trimmed and an empty chunk is dropped', () => {
  const text =
    '\n--> statement-breakpoint\n  A;  \n--> statement-breakpoint\n\n--> statement-breakpoint\nB;\n--> statement-breakpoint\n';

  expect(statementsOfNoTransactionFile(text)).toEqual(['A;', 'B;']);
});

/** A failed concurrent build leaves an invalid index that IF NOT EXISTS would skip, so a build follows a drop. */
function problemsInNoTransactionFile(text: string): string[] {
  const problems: string[] = [];
  const dropped = new Set<string>();

  for (const statement of statementsOfNoTransactionFile(text)) {
    const sql = statement.replace(/^\s*--.*$/gm, '').trim();
    const drop = /^DROP INDEX CONCURRENTLY IF EXISTS (\w+);$/.exec(sql)?.[1];
    const build = /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY (\w+) ON [^;]+;?$/.exec(sql)?.[1];

    if (drop !== undefined) dropped.add(drop);
    else if (build === undefined) problems.push(`not a concurrent index statement: ${sql}`);
    else if (!dropped.has(build)) problems.push(`${build} is built without dropping it first`);
  }

  return problems;
}

test.each([
  [
    'an index built without a drop before it',
    'CREATE INDEX CONCURRENTLY a_n ON a (n);',
    ['a_n is built without dropping it first'],
  ],
  [
    'an index built before its drop',
    'CREATE INDEX CONCURRENTLY a_n ON a (n);\n--> statement-breakpoint\nDROP INDEX CONCURRENTLY IF EXISTS a_n;',
    ['a_n is built without dropping it first'],
  ],
  [
    'an index built without CONCURRENTLY',
    'CREATE INDEX a_n ON a (n);',
    ['not a concurrent index statement: CREATE INDEX a_n ON a (n);'],
  ],
  [
    'a statement that is not an index at all',
    'ALTER TABLE a ADD COLUMN m int;',
    ['not a concurrent index statement: ALTER TABLE a ADD COLUMN m int;'],
  ],
  [
    'a build chunk that holds a second statement',
    'DROP INDEX CONCURRENTLY IF EXISTS a_n;\n--> statement-breakpoint\nCREATE INDEX CONCURRENTLY a_n ON a (n);\nALTER TABLE a ADD COLUMN m int;',
    [
      'not a concurrent index statement: CREATE INDEX CONCURRENTLY a_n ON a (n);\nALTER TABLE a ADD COLUMN m int;',
    ],
  ],
  [
    'a drop chunk that holds a second statement',
    'DROP INDEX CONCURRENTLY IF EXISTS a_n;\nALTER TABLE a ADD COLUMN m int;',
    [
      'not a concurrent index statement: DROP INDEX CONCURRENTLY IF EXISTS a_n;\nALTER TABLE a ADD COLUMN m int;',
    ],
  ],
])('the no-transaction rule finds %s', (_label, text, expected) => {
  expect(problemsInNoTransactionFile(text)).toEqual(expected);
});

test('the no-transaction rule accepts a drop followed by a build, with comments', () => {
  const text = `-- Why: the lookup of alerts by rule and target.\n${concurrentIndexMigration}`;

  expect(problemsInNoTransactionFile(text)).toEqual([]);
});

test('every no-transaction migration holds only concurrent index statements, each after a drop of that index', async () => {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const names = (await readdir(directory)).filter(name => name.endsWith('.no-transaction.sql'));
  const offenders: string[] = [];

  for (const name of names) {
    const text = await readFile(join(directory, name), 'utf8');

    offenders.push(...problemsInNoTransactionFile(text).map(problem => `${name}: ${problem}`));
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
