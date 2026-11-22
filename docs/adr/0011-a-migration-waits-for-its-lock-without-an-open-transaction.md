# A migration waits for its lock without an open transaction

## Status

Accepted on 22 November 2026. The code lands with this decision. It adds to [ADR 0010](0010-a-migration-lock-keeps-pending-migrations-to-one-process.md). The session advisory lock, the fixed pair `871530214, 1`, the reserved connection, and the PGlite no-op stay as that record decided. Where that record says the second process blocks inside `pg_advisory_lock`, follow this record instead.

## Context

ADR 0010 takes the session advisory lock on one reserved connection and holds it while the pending files run. The second process blocks inside `pg_advisory_lock(871530214, 1)` until the first unlocks.

That block is a running statement, so PostgreSQL keeps a transaction open until the statement ends. `CREATE INDEX CONCURRENTLY` waits for transactions that are already open. The process that holds the advisory lock is the one running the build. The process that wants the lock is the open transaction. Neither can finish.

PostgreSQL reports `40P01`. One process waits for an exclusive lock on advisory lock `(871530214, 1)`. The other waits for a share lock on the first process's virtual transaction.

The failure is a race. It happens when one process reaches a `.no-transaction.sql` build while the other is still inside `pg_advisory_lock`. A run where the second process has not started waiting, or where no pending file builds an index concurrently, succeeds. Two stores migrating an empty database passed on the lock's own pull request, then deadlocked in CI once a concurrent index was pending.

A transaction-level lock does not remove the wait. ADR 0010 already rejects `pg_advisory_xact_lock`: holding it across the files would make the run one transaction, and `CREATE INDEX CONCURRENTLY` cannot run inside one.

## Decision

The reserved connection takes the same session advisory lock with `pg_try_advisory_lock(871530214, 1)`. The call returns immediately. When it returns false, the process waits briefly and tries again, and the connection is idle during that wait. When it returns true, the process runs the pending files on that connection and then `pg_advisory_unlock(871530214, 1)`.

For example, two processes start against an empty database whose pending files include `CREATE INDEX CONCURRENTLY`. The first try succeeds and that process builds the index. The second try returns false, so that session sits idle while the index builds. The build is not waiting on a transaction that is itself waiting for the lock. The first process records the file and unlocks. The second try then succeeds, finds the file recorded, and unlocks. Both processes continue.

## Consequences

A second process still waits until the first has recorded every pending file, or has failed and released the lock. The wait is a loop in the client. A crash still drops the lock when the session ends, because the lock is the session lock from ADR 0010.

The loop does not time out. A lock that is never released leaves the process waiting, which is what a blocking `pg_advisory_lock` would do.

PGlite still takes no lock. The service runs it as one connection inside one process.
