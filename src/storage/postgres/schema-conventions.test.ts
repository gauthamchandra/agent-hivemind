import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openMigratedDatabase } from '@/testing/pglite.ts';

// Both lists only shrink. Fix one in a forward migration, then delete it here: the tests compare
// with toEqual, so a fixed entry that stays listed fails too.
const timestampColumnsThatPredateTheNamingRule = ['spawn_log.at', 'task_events.at'];

const tablesThatPredateTheCommentRule = [
  'accounts',
  'connection_rate_windows',
  'connection_send_pauses',
  'connections',
  'context_notes',
  'enrollment_codes',
  'groups',
  'idempotency_keys',
  'messages',
  'operator_keys',
  'outbox_copies',
  'people',
  'sessions',
  'spawn_log',
  'task_events',
  'tasks',
  'waits',
  'workspaces',
];

test('every timestamp column is named something_at or something_until', async () => {
  const db = await openMigratedDatabase();

  const misnamed = await db.query<{ column: string }>(
    `SELECT table_name || '.' || column_name AS "column"
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type LIKE 'timestamp%'
       AND column_name !~ '_(at|until)$'
     ORDER BY 1`
  );

  expect(misnamed.rows.map(row => row.column)).toEqual(timestampColumnsThatPredateTheNamingRule);
});

test('every table has a comment that says what it holds', async () => {
  const db = await openMigratedDatabase();

  const uncommented = await db.query<{ table: string }>(
    `SELECT c.relname AS "table"
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname <> 'schema_migrations'
       AND obj_description(c.oid, 'pg_class') IS NULL
     ORDER BY 1`
  );

  expect(uncommented.rows.map(row => row.table)).toEqual(tablesThatPredateTheCommentRule);
});

test('no migration both adds a constraint NOT VALID and validates it', async () => {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();

  const migrations = await Promise.all(
    names.map(async name => ({ name, sql: await readFile(`${directory}${name}`, 'utf8') }))
  );

  // The runner sends a file as one call, so VALIDATE CONSTRAINT would scan the table while the
  // ALTER TABLE lock from the same file is still held.
  const holdingTheLockWhileScanning = migrations.filter(
    ({ sql }) => /\bNOT\s+VALID\b/i.test(sql) && /\bVALIDATE\s+CONSTRAINT\b/i.test(sql)
  );

  expect(holdingTheLockWhileScanning.map(({ name }) => name)).toEqual([]);
});
