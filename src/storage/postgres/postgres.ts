import { SQL } from 'bun';
import type { Store } from '@/ports/storage.ts';
import { applyMigrations, executePostgres } from '@/storage/postgres/migrate.ts';
import { openSqlStore, type Sql } from '@/storage/postgres/store.ts';

export type PostgresStore = Store & {
  exec(text: string): Promise<void>;
  close(): Promise<void>;
};

/**
 * Session advisory lock for pending migrations.
 *
 * <p>Every process takes this same pair. The numbers are fixed, not hashed, because
 * {@code hashtext} can change between PostgreSQL majors. See ADR 0010.
 */
const migrationLockClassId = 871530214;
const migrationLockObjectId = 1;

/**
 * A PostgreSQL store. Bun's client holds `SELECT … FOR UPDATE` until the transaction ends.
 *
 * <p>With no directory, the store applies the migration files shipped with this package.
 */
export function openPostgresStore(
  connectionString: string,
  migrationsDirectory?: string
): PostgresStore {
  const client = new SQL(connectionString);
  const store = openSqlStore(
    {
      transaction: work => client.begin(tx => work(adapter(tx))),
      query: (text, params) => rowsOf(client, text, params),
      exec: text => client.unsafe(text),
    },
    () => migrateUnderLock(client, migrationsDirectory)
  );

  return {
    ...store,
    async exec(text) {
      await client.unsafe(text);
    },
    close() {
      return client.close();
    },
  };
}

const migrationLockRetryMs = 50;

/**
 * Apply pending migrations while this process holds the session advisory lock.
 *
 * <p>{@code reserve} keeps one pooled connection until {@code release}. The lock and the files
 * share that connection. The lock is released on success or failure. See ADR 0010 and ADR 0011.
 */
async function migrateUnderLock(client: SQL, migrationsDirectory?: string): Promise<void> {
  const reserved = await client.reserve();

  try {
    await waitForMigrationLock(reserved);

    try {
      await applyMigrations(
        executePostgres(sql => rowsOf(reserved, sql)),
        migrationsDirectory
      );
    } finally {
      await reserved.unsafe(migrationLockSql('pg_advisory_unlock'));
    }
  } finally {
    reserved.release();
  }
}

/**
 * Take the session advisory lock without leaving a transaction open during the wait.
 *
 * <p>A blocking {@code pg_advisory_lock} is one statement, so the waiter holds a transaction
 * until the lock is free. {@code CREATE INDEX CONCURRENTLY} waits for transactions that are
 * already open, and the two deadlock. {@code pg_try_advisory_lock} returns immediately, and
 * this connection is idle between tries. See ADR 0011.
 */
async function waitForMigrationLock(reserved: SQL): Promise<void> {
  for (;;) {
    if (await migrationLockIsHeld(reserved)) return;

    await Bun.sleep(migrationLockRetryMs);
  }
}

async function migrationLockIsHeld(reserved: SQL): Promise<boolean> {
  const result = await reserved.unsafe(`${migrationLockSql('pg_try_advisory_lock')} AS locked`);

  return migrationLockHeld(result);
}

function migrationLockHeld(result: unknown): boolean {
  const row = Array.isArray(result) ? result[0] : undefined;
  const locked =
    typeof row === 'object' && row !== null && 'locked' in row ? row.locked : undefined;

  if (typeof locked !== 'boolean') {
    throw new Error('pg_try_advisory_lock did not return a boolean.');
  }

  return locked;
}

function migrationLockSql(action: 'pg_try_advisory_lock' | 'pg_advisory_unlock'): string {
  return `SELECT ${action}(${migrationLockClassId}, ${migrationLockObjectId})`;
}

function adapter(client: SQL): Sql {
  return {
    query: (text, params) => rowsOf(client, text, params),
    exec: text => client.unsafe(text),
  };
}

async function rowsOf<T>(client: SQL, text: string, params?: unknown[]): Promise<{ rows: T[] }> {
  const result = await client.unsafe(text, params ?? []);
  const rows = Array.isArray(result) ? [...result] : [];

  return { rows: rows as T[] };
}
