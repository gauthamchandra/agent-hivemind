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

/** A PostgreSQL store. Bun's client holds `SELECT … FOR UPDATE` until the transaction ends. */
export function openPostgresStore(connectionString: string): PostgresStore {
  const client = new SQL(connectionString);
  const store = openSqlStore(
    {
      transaction: work => client.begin(tx => work(adapter(tx))),
      query: (text, params) => rowsOf(client, text, params),
      exec: text => client.unsafe(text),
    },
    () => migrateUnderLock(client)
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

/**
 * Apply pending migrations while this process holds the session advisory lock.
 *
 * <p>{@code reserve} keeps one pooled connection until {@code release}. The lock and the files
 * share that connection. A transaction-level lock would keep a transaction open, and
 * {@code CREATE INDEX CONCURRENTLY} cannot run inside one. The lock is released on success or
 * failure. See ADR 0010.
 */
async function migrateUnderLock(client: SQL): Promise<void> {
  const reserved = await client.reserve();

  try {
    await reserved.unsafe(migrationLockSql('pg_advisory_lock'));

    try {
      await applyMigrations(executePostgres(sql => rowsOf(reserved, sql)));
    } finally {
      await reserved.unsafe(migrationLockSql('pg_advisory_unlock'));
    }
  } finally {
    reserved.release();
  }
}

function migrationLockSql(action: 'pg_advisory_lock' | 'pg_advisory_unlock'): string {
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
