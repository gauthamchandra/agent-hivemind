import { expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { SQL } from 'bun';
import { openPostgresStore } from '@/storage/postgres/postgres.ts';
import { runAfterTest } from '@/testing/teardown.ts';

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
