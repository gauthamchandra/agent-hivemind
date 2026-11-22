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

const noTransactionSuffix = '.no-transaction.sql';

/**
 * Apply every migration file that is not recorded yet, in name order.
 *
 * <p>A file runs as one script, so PostgreSQL wraps it in a transaction and a failure leaves
 * nothing behind. {@code CREATE INDEX CONCURRENTLY} cannot run inside a transaction, so a file
 * named {@code *.no-transaction.sql} runs one statement per call instead, split at the
 * {@code --> statement-breakpoint} lines. Such a file is not atomic: after a failure it runs again
 * from its first statement, so every statement in it must be safe to repeat. This function takes
 * no lock. The PostgreSQL store holds a session advisory lock around the call, and releases it
 * on success or failure. PGlite does not take that lock. See ADR 0009 and ADR 0010.
 */
export async function applyMigrations(
  execute: ExecuteSql,
  directory = migrationsDirectory
): Promise<void> {
  const umzug = new Umzug<MigrationContext>({
    migrations: {
      glob: ['*.sql', { cwd: directory }],
      resolve: ({ name, path, context }) => {
        if (path === undefined) {
          throw new Error(`Migration ${name} has no file.`);
        }

        return {
          name,
          up: async () => {
            const sql = await readFile(path, 'utf8');

            await executeMigration(context.execute, name, sql);
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

async function executeMigration(execute: ExecuteSql, name: string, sql: string): Promise<void> {
  if (!name.endsWith(noTransactionSuffix)) {
    await execute(sql);

    return;
  }

  for (const statement of statementsOfNoTransactionFile(sql)) await execute(statement);
}

/** The statements of a no-transaction file: the text between `--> statement-breakpoint` lines. */
export function statementsOfNoTransactionFile(sql: string): string[] {
  return sql
    .split(/^--> statement-breakpoint[ \t\r]*$/m)
    .map(statement => statement.trim())
    .filter(statement => statement !== '');
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
