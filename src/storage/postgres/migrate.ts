import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Umzug, type UmzugStorage } from 'umzug';

export type ExecuteSql = (sql: string) => Promise<unknown>;

type MigrationContext = {
  execute: ExecuteSql;
};

const migrationsDirectory = fileURLToPath(new URL('./migrations/', import.meta.url));

export function executePglite(db: { exec(sql: string): Promise<unknown> }): ExecuteSql {
  return sql => db.exec(sql);
}

export function executePostgres(query: (sql: string) => Promise<unknown>): ExecuteSql {
  return sql => query(sql);
}

export async function applyMigrations(execute: ExecuteSql): Promise<void> {
  const umzug = new Umzug<MigrationContext>({
    migrations: {
      glob: ['*.sql', { cwd: migrationsDirectory }],
      resolve: ({ name, path, context }) => {
        if (path === undefined) {
          throw new Error(`Migration ${name} has no file.`);
        }

        return {
          name,
          up: async () => {
            const sql = await readFile(path, 'utf8');

            await context.execute(sql);
          },
        };
      },
    },
    context: { execute },
    storage: historyStorage(),
    logger: undefined,
  });

  await umzug.up();
}

function historyStorage(): UmzugStorage<MigrationContext> {
  return {
    async executed({ context }) {
      await ensureHistory(context.execute);

      const result = await context.execute('SELECT name FROM schema_migrations ORDER BY name');

      return namesFrom(result);
    },

    async logMigration({ name, context }) {
      await context.execute(`INSERT INTO schema_migrations (name) VALUES (${sqlText(name)})`);
    },

    async unlogMigration() {
      throw new Error('Migrations are forward only.');
    },
  };
}

async function ensureHistory(execute: ExecuteSql): Promise<void> {
  await execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY
    )`
  );
}

function namesFrom(result: unknown): string[] {
  return rowsFrom(result).map(row => {
    const name = row.name;

    if (typeof name !== 'string') {
      throw new Error('schema_migrations.name is not text.');
    }

    return name;
  });
}

function rowsFrom(result: unknown): Record<string, unknown>[] {
  const record = resultRecord(result);

  if (record === null || !Array.isArray(record.rows)) {
    throw new Error('SQL execute did not return rows.');
  }

  return record.rows.filter(isRecord);
}

function resultRecord(result: unknown): { rows?: unknown } | null {
  if (Array.isArray(result)) {
    const last = result.at(-1);

    return isRecord(last) ? last : null;
  }

  return isRecord(result) ? result : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
