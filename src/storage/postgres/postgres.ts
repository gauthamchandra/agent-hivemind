import { SQL } from 'bun';
import type { Store } from '@/ports/storage.ts';
import { applyMigrations, executePostgres } from '@/storage/postgres/migrate.ts';
import { openSqlStore, type Sql } from '@/storage/postgres/store.ts';

export type PostgresStore = Store & {
  exec(text: string): Promise<void>;
  close(): Promise<void>;
};

/** A PostgreSQL store. Bun's client holds `SELECT … FOR UPDATE` until the transaction ends. */
export function openPostgresStore(connectionString: string): PostgresStore {
  const client = new SQL(connectionString);
  const store = openSqlStore(
    {
      transaction: work => client.begin(tx => work(adapter(tx))),
      query: (text, params) => rowsOf(client, text, params),
      exec: text => client.unsafe(text),
    },
    () => applyMigrations(executePostgres(sql => rowsOf(client, sql)))
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
