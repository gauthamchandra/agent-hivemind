import { describe, expect, test } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { applyMigrations, executePglite, executePostgres } from '@/storage/postgres/migrate.ts';

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

describe('sql migrations', () => {
  test('pglite and a postgres execute function apply the same files once', async () => {
    const pglite = new PGlite();
    const postgres = new PGlite();
    await pglite.waitReady;
    await postgres.waitReady;

    const executePostgresScript = executePostgres(async sql => {
      const results = await postgres.exec(sql);

      return results.at(-1) ?? { rows: [] };
    });

    await applyMigrations(executePglite(pglite));
    await applyMigrations(executePostgresScript);

    expect(await appliedNames(pglite)).toEqual(['001_initial.sql']);
    expect(await appliedNames(postgres)).toEqual(['001_initial.sql']);
    expect(await publicTable(pglite, 'workspaces')).toBe(1);
    expect(await publicTable(postgres, 'workspaces')).toBe(1);
    expect(await publicTable(pglite, 'migrations')).toBe(0);
    expect(await publicTable(postgres, 'migrations')).toBe(0);

    const drizzle = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.schemata
       WHERE schema_name = 'drizzle'`
    );

    expect(drizzle.rows[0]?.count).toBe(0);

    await applyMigrations(executePglite(pglite));
    await applyMigrations(executePostgresScript);

    expect(await appliedNames(pglite)).toEqual(['001_initial.sql']);
    expect(await appliedNames(postgres)).toEqual(['001_initial.sql']);

    const workspaces = await pglite.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM workspaces'
    );

    expect(workspaces.rows[0]?.count).toBe(0);
    await pglite.close();
    await postgres.close();
  });
});
