# A migration that cannot run in a transaction lives in its own file

## Status

Accepted on 21 November 2026. The code lands with this decision. It adds to [ADR 0001](0001-forward-only-sql-migrations.md) and changes nothing that ADR decided: migrations are still forward only, and a normal file still runs as one script.

## Context

ADR 0001 has the runner send each migration file as one script. PostgreSQL runs a script of several commands inside one transaction, so a file that fails leaves nothing behind. That is what makes a failed migration safe.

Building an index on a table that already holds rows blocks writes to that table while the build runs, and ADR 0001 requires a file to be safe while the previous release is still serving. `CREATE INDEX CONCURRENTLY` does not block writes, but it cannot run inside a transaction. A script of several commands is one, so PostgreSQL refuses it with `CREATE INDEX CONCURRENTLY cannot run inside a transaction block`. `DROP INDEX CONCURRENTLY` is refused the same way, and so is PGlite, which the tests use. Sent as one command per call, each statement runs on both, through Bun's PostgreSQL client too.

A concurrent build that fails leaves an invalid index behind. A unique index over duplicate rows does this, and so does a build that was cancelled. `CREATE INDEX IF NOT EXISTS` skips an index whose name exists, so it would keep the invalid one, unused, for good. Only dropping the index first repairs it.

## Decision

A migration file whose name ends in `.no-transaction.sql` runs one statement per call. The runner splits it at the `--> statement-breakpoint` lines that the migration files already carry. Every other file still runs as one script. The file keeps its place in the numbered order, and its full name is what `schema_migrations` records.

A no-transaction file holds only concurrent index statements. An index on an existing table is built in such a file. An index on a table that the same migration creates stays in the normal file, because nothing can be writing to that table yet.

A no-transaction file is not atomic. A failure part way leaves the earlier statements applied, the name is not recorded, and the file runs again from its first statement the next time the service starts. So each build is preceded by `DROP INDEX CONCURRENTLY IF EXISTS` for the same index. `src/storage/postgres/migrate.test.ts` fails when a no-transaction file holds any other statement, or builds an index that it did not drop first.

For example, `018_alerts_rule_target_index.no-transaction.sql` holds two statements:

```sql
DROP INDEX CONCURRENTLY IF EXISTS alerts_rule_target;
--> statement-breakpoint
CREATE INDEX CONCURRENTLY alerts_rule_target ON alerts (rule, target_id);
```

The runner sends the first statement, then the second. If the build fails, the invalid index stays until the next start. That start drops it and builds it again.

## Consequences

A no-transaction file can stop half way. A start that finds its name unrecorded runs it from the top, so a build that had already succeeded is dropped and built again. That costs a rebuild, and queries lose the index while it runs.

Statements in one chunk run as a script again. Two statements between the same pair of breakpoint lines fail with the transaction error, and the tests that apply every migration show the mistake.

Nothing serializes migrations across processes. Every service process runs the pending files at startup, so two processes that start together can both run the same file. A normal file is all-or-nothing, and the process that loses fails to start. A no-transaction file is not, and there the loser can drop an index that the winner built and then fail before it builds the index again. The winner has already recorded the name, so the index stays missing until someone builds it by hand. A database lock around the whole run would close this. It is not part of this decision.

Only concurrent index statements are allowed. Another statement that cannot run in a transaction needs its own decision.

PGlite has one connection, so a build there is not concurrent in effect. It accepts the same statements, so the same files run in the tests.
