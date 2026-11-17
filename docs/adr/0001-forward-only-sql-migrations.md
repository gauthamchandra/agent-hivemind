# Forward-only plain SQL migrations

## Status

Accepted on 16 November 2026.

## Why do this

The schema is a sequence of SQL scripts. Tests apply those scripts to PGlite, an in-process PostgreSQL. A deployed installation applies the same scripts to PostgreSQL. The runner's only job is to play the files that have not been recorded yet.

Drizzle was the first runner. Drizzle is an object-relational mapper: a query builder and a set of schema objects. The application never built a query with it. Using it to execute `.sql` files put an unused mapper on the dependency list and recorded history in `drizzle.__drizzle_migrations`, a table owned by that mapper.

A migration that has already run in production cannot be undone underneath a process that is still serving. The previous release and the new release overlap. A down script pretends that overlap does not exist.

## The shape of a migration

1. Files named in order, such as `001_initial.sql`, live in `src/storage/postgres/migrations`.
2. Umzug lists those files and skips any name already stored.
3. The driver executes the file through one function. PGlite passes `sql => db.exec(sql)`. PostgreSQL passes `sql => query(sql)`.
4. Umzug inserts the file name into `schema_migrations`.
5. Nothing in this repository calls Umzug's `down` or `rollback`.

`schema_migrations` has one column, `name text primary key`. The runner creates that table. The product SQL does not.

## Tenets

- The schema is the SQL file. There is no query builder and no schema object in the migration path.
- The same file runs on PGlite and on PostgreSQL. Only the execute function changes.
- Migrations are forward only and zero-downtime. A file must be safe while the previous release is still serving.
- A mistake is corrected by a later file.

## What this rules out

**Drizzle as the runner.** The mapper was the part that was not wanted. Its history table is not a plain list of file names.

**Flyway.** Flyway already runs ordered SQL files and a history table. It runs on the JVM. This repository is Bun and TypeScript.

**A migrator written here.** Umzug already orders the files, skips recorded names, and applies the rest. The database-specific code is the execute function and the one history table its storage interface requires.

**A down script per file.** The reverse change goes stale as soon as a later file depends on the earlier one, and production must not run it during a release.

## Consequences

Umzug records the file name and nothing else. Changing a file after it has been applied does not change that name, so the runner will not apply the edit and will not report it. Do not edit a file that has shipped. Add a file.

Zero-downtime is a constraint on what the file may do. The previous release keeps running while the file runs. Do not take a lock that stalls that release, and do not drop or rename a column it still reads. Add the new shape first. Remove the old shape in a later file, after the release that stopped reading it is gone.

Umzug still has a `down` method. Calling it would ask the storage to forget a recorded name without a reverse script. `unlogMigration` throws instead of deleting the row, and Biome rejects a call to `down` or `rollback` under `src/`. Those checks do not remove the method from the library.

The PostgreSQL execute function has to send the file as one script. A prepared statement accepts a single command, and these files contain many commands, including function bodies. PGlite's `exec` runs a script. PGlite's `query` does not. The PostgreSQL `query` passed to the runner has to be the same kind of script execution, not a prepared statement.

There is no production database to convert. Tests start from an empty PGlite. A later branch that looked for a Drizzle journal has to read `schema_migrations` instead.

## Rollout

None. The history table is created the first time migrations run.
