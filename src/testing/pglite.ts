import { PGlite } from '@electric-sql/pglite';
import { openPgliteStore } from '@/storage/postgres/store.ts';
import { runAfterTest } from '@/testing/teardown.ts';

let migratedSnapshot: Promise<Blob> | null = null;

/**
 * Open an empty in-memory database that closes after the current test.
 *
 * <p>Reach for this only when the test needs a database with no tables. Every call runs
 * Postgres {@code initdb}, which costs about 600ms. Use {@link openMigratedDatabase} otherwise.
 */
export function openEmptyDatabase(): Promise<PGlite> {
  return closeAfterTest(new PGlite());
}

/**
 * Open an in-memory database with every migration applied that closes after the current test.
 *
 * <p>The migrated state is built once per process and restored from a snapshot, which skips
 * {@code initdb} and the migrations and costs about 100ms instead of 650ms.
 */
export async function openMigratedDatabase(): Promise<PGlite> {
  migratedSnapshot ??= buildMigratedSnapshot();

  return closeAfterTest(new PGlite({ loadDataDir: await migratedSnapshot }));
}

async function closeAfterTest(database: PGlite): Promise<PGlite> {
  runAfterTest(() => (database.closed ? undefined : database.close()));
  await database.waitReady;

  return database;
}

async function buildMigratedSnapshot(): Promise<Blob> {
  const seed = new PGlite();

  try {
    await openPgliteStore(seed).migrate();

    return await seed.dumpDataDir('none');
  } finally {
    await seed.close();
  }
}
