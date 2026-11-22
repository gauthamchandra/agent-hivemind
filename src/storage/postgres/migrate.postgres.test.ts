import { expect, test } from 'bun:test';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SQL } from 'bun';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { createTemporaryDirectory } from '@/testing/files.ts';
import { runAfterTest } from '@/testing/teardown.ts';

const concurrentIndexAttempts = 3;

const databaseUrl = process.env.HIVEMIND_POSTGRES_URL;

test.skipIf(databaseUrl === undefined)(
  'two stores calling migrate at once on an empty database both succeed',
  async () => {
    const adminUrl = databaseUrl ?? '';
    const name = emptyDatabaseName();
    const admin = new SQL(adminUrl);

    runAfterTest(async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    });

    await admin.unsafe(`CREATE DATABASE ${name}`);

    const emptyUrl = databaseUrlWithName(adminUrl, name);
    const left = openPostgresStore(emptyUrl);
    const right = openPostgresStore(emptyUrl);
    const reader = new SQL(emptyUrl);

    runAfterTest(async () => {
      await left.close();
      await right.close();
      await reader.close();
    });

    const results = await Promise.allSettled([left.migrate(), right.migrate()]);

    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }

    const names = await recordedMigrationNames(reader);

    expect(names).toEqual(await migrationFiles());

    const tables = await reader.unsafe(
      `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'workspaces'`
    );
    const table = Array.isArray(tables) ? tables[0] : undefined;

    expect(Number(table?.count)).toBe(1);
  }
);

test.skipIf(databaseUrl === undefined)(
  'two stores calling migrate at once both succeed when a file builds an index concurrently',
  async () => {
    const adminUrl = requirePresent(databaseUrl, 'HIVEMIND_POSTGRES_URL should be set');
    const admin = new SQL(adminUrl);
    const names: string[] = [];

    runAfterTest(async () => {
      for (const name of names) {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }

      await admin.close();
    });

    for (let attempt = 0; attempt < concurrentIndexAttempts; attempt += 1) {
      const name = emptyDatabaseName();

      names.push(name);
      await admin.unsafe(`CREATE DATABASE ${name}`);
      await expectBothMigrate(databaseUrlWithName(adminUrl, name));
    }
  }
);

/**
 * The build waits until the other session has reached the lock.
 *
 * <p>A fixed sleep can end before that session is waiting, and then a blocking
 * {@code pg_advisory_lock} never overlaps {@code CREATE INDEX CONCURRENTLY}. The gate stays
 * shut until {@code pg_stat_activity} shows the waiter, so the overlap is the one that deadlocks.
 */
async function expectBothMigrate(emptyUrl: string): Promise<void> {
  const directory = await createTemporaryDirectory('hivemind-miglock-');

  await writeFile(join(directory, '001_probe.no-transaction.sql'), concurrentProbeMigration());

  const left = openPostgresStore(emptyUrl, directory);
  const right = openPostgresStore(emptyUrl, directory);
  const reader = new SQL(emptyUrl);
  const pending = Promise.allSettled([left.migrate(), right.migrate()]);

  runAfterTest(async () => {
    await left.close();
    await right.close();
    await reader.close();
  });

  try {
    await waitUntilPeerIsAtLock(reader);
    await reader.unsafe('UPDATE miglock_probe SET id = 1');

    const results = await pending;

    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  } finally {
    await reader.unsafe('UPDATE miglock_probe SET id = 1').catch(() => undefined);
    await pending;
  }

  expect(await recordedMigrationNames(reader)).toEqual(['001_probe.no-transaction.sql']);

  const indexes = await reader.unsafe(
    `SELECT i.indisvalid AS valid
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relname = 'miglock_probe_id'`
  );
  const index = requirePresent(
    Array.isArray(indexes) ? indexes[0] : undefined,
    'miglock_probe_id should exist'
  );

  expect(index.valid).toBe(true);
}

function concurrentProbeMigration(): string {
  return [
    'CREATE TABLE miglock_probe (id integer);',
    'INSERT INTO miglock_probe (id) VALUES (0);',
    `DO $body$
DECLARE
  started timestamptz := clock_timestamp();
BEGIN
  -- miglock_gate
  WHILE (SELECT id FROM miglock_probe) = 0 LOOP
    IF clock_timestamp() > started + interval '10 seconds' THEN
      RAISE EXCEPTION 'migration lock waiter was not observed';
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
END
$body$;`,
    'DROP INDEX CONCURRENTLY IF EXISTS miglock_probe_id;',
    'CREATE INDEX CONCURRENTLY miglock_probe_id ON miglock_probe (id);',
  ].join('\n--> statement-breakpoint\n');
}

async function waitUntilPeerIsAtLock(sql: SQL): Promise<void> {
  const deadline = Date.now() + 5_000;

  for (;;) {
    const rows = await sql.unsafe(
      `SELECT
         EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND state = 'active'
             AND query LIKE '%miglock' || '_gate%'
         ) AS holder,
         EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND (
               (state = 'idle' AND query LIKE '%pg_try_advisory_lock%')
               OR (
                 state = 'active'
                 AND wait_event_type = 'Lock'
                 AND query LIKE '%pg_advisory_lock%'
                 AND query NOT LIKE '%pg_try_advisory_lock%'
               )
             )
         ) AS waiter`
    );
    const row = Array.isArray(rows) ? rows[0] : undefined;

    if (row?.holder === true && row?.waiter === true) return;

    if (Date.now() > deadline) {
      throw new Error('the second migrate did not reach the lock before the index build');
    }

    await Bun.sleep(20);
  }
}

function emptyDatabaseName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');

  return `miglock_${hex}`;
}

function databaseUrlWithName(base: string, name: string): string {
  const url = new URL(base);

  url.pathname = `/${name}`;

  return url.toString();
}

async function migrationFiles(): Promise<string[]> {
  const directory = fileURLToPath(new URL('./migrations/', import.meta.url));

  return (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
}

async function recordedMigrationNames(sql: SQL): Promise<string[]> {
  const result = await sql.unsafe('SELECT name FROM schema_migrations ORDER BY name');
  const rows = Array.isArray(result) ? result : [];

  return rows.map(row => {
    const name = row.name;

    if (typeof name !== 'string') throw new Error('schema_migrations.name is not text.');

    return name;
  });
}
