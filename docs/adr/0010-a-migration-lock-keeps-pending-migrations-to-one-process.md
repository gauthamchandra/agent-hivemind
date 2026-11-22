# A migration lock keeps pending migrations to one process

## Status

Accepted on 22 November 2026. The code lands with this decision. It adds to [ADR 0001](0001-forward-only-sql-migrations.md) and [ADR 0009](0009-a-migration-that-cannot-run-in-a-transaction-lives-in-its-own-file.md). Migrations stay forward only, a normal file still runs as one script, and a `.no-transaction.sql` file still runs one statement per call.

## Context

Every process that opens the PostgreSQL store runs the pending migration files at startup. ADR 0001 sends each normal file as one script, so PostgreSQL runs it in one transaction and a failure leaves nothing behind. ADR 0009 sends a `.no-transaction.sql` file one statement per call, because `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. That file is not atomic. A failure leaves the earlier statements applied and the name unrecorded, and the next start runs the file again from its first statement.

Nothing in those decisions stops two processes from running the same file together. On an empty database both run `001_initial.sql`, and one fails with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`. The loser of a normal file leaves nothing behind. The loser of a `.no-transaction.sql` file can `DROP INDEX CONCURRENTLY` an index the winner has just built, then fail before it builds the index again. The winner has already recorded the name, so the index stays missing.

The runner applies files through one function that has no connection of its own. A lock has to be taken before that function reads `schema_migrations` and held until it records the last name. Bun's `SQL` client pools connections and may hand each statement a different one. `sql.reserve()` takes one connection out of the pool and holds it until `release()`, so session state on that connection survives from statement to statement. `sql.begin()` also takes one connection, and every statement in its callback runs inside one transaction. Releasing a reserved connection that is still inside a transaction closes that connection, and the server rolls the transaction back.

## Decision

The PostgreSQL store reserves one connection, takes the session advisory lock `pg_advisory_lock(871530214, 1)` on it, and runs the pending files on that same connection. The two numbers are a fixed pair reserved for this lock. They are not hashed, because `hashtext` can change between PostgreSQL majors. When the run finishes or throws, the store runs `pg_advisory_unlock(871530214, 1)` and then `release()`. If the process dies first, PostgreSQL drops the lock when the session ends.

PGlite does not take the lock. The service runs it as one connection inside one process, and a second process does not share that database.

A transaction-level lock does not fit this run. `pg_advisory_xact_lock` lasts until its transaction ends, so holding it across every file would make the run one transaction. A `.no-transaction.sql` statement cannot run inside that transaction. Holding the transaction open on a second connection while the files run elsewhere makes `CREATE INDEX CONCURRENTLY` wait for the open transaction, and the transaction waits for the build to finish.

For example, two processes start against an empty database. The first reserves a connection, takes `pg_advisory_lock(871530214, 1)`, and runs `001_initial.sql`. The second blocks in `pg_advisory_lock(871530214, 1)`. The first records the file and unlocks. The second takes the lock, reads `schema_migrations`, finds the file recorded, and unlocks. Both processes continue. Without the lock, both run `001_initial.sql` and one fails with `duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.

## Consequences

A second process waits at startup until the first has recorded every pending file, or has failed and released the lock. The lock is advisory, so queries from the previous release are not blocked while the files run. ADR 0001 still forbids a lock that stalls that release. This lock does not take one.

The lock does not make a `.no-transaction.sql` file atomic. A process that dies between two of its statements leaves those statements applied and the name unrecorded. The next process takes the lock and runs the file from the first statement, which is the recovery ADR 0009 already requires. What the lock changes is that a second process cannot run that file at the same time, so it cannot drop an index the first process has recorded.

The lock is not a row in `job_locks`. That table is created by a migration, and the collision happens on an empty database, before any migration has been recorded.

The process started from `src/index.ts` uses PGlite, so this lock is not on that path. Two processes that share a PostgreSQL server take it, because that is the store they share.

PGlite tests do not show two processes migrating one database. A test with two PostgreSQL stores, both calling `migrate()` on an empty database, does.
