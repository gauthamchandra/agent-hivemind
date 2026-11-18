import type { PGlite, Transaction } from '@electric-sql/pglite';
import { requireConnectionId } from '@/domain/ids.ts';
import type { Store, UnitOfWork } from '@/ports/storage.ts';
import { accountWork } from '@/storage/postgres/account-work.ts';
import { groupWork } from '@/storage/postgres/group-work.ts';
import { jobHousekeeping } from '@/storage/postgres/job-housekeeping.ts';
import { jobLocks } from '@/storage/postgres/job-locks.ts';
import { jobState } from '@/storage/postgres/job-state.ts';
import { inLockOrder } from '@/storage/postgres/lock-order.ts';
import { messageWork } from '@/storage/postgres/message-records.ts';
import { applyMigrations, executePglite } from '@/storage/postgres/migrate.ts';
import { readEvents } from '@/storage/postgres/parse-event.ts';
import { parseGroup } from '@/storage/postgres/parse-group.ts';
import { readTasks } from '@/storage/postgres/parse-task.ts';
import { codeWork } from '@/storage/postgres/session-codes.ts';
import { counterWork } from '@/storage/postgres/session-counters.ts';
import { readOccupancy, readSession, readSessions } from '@/storage/postgres/session-read.ts';
import { rowWork } from '@/storage/postgres/session-row-work.ts';
import {
  one,
  oneParsed,
  readString,
  run,
  type Sql,
  type SqlDatabase,
} from '@/storage/postgres/store-query.ts';
import { taskWork } from '@/storage/postgres/task-work.ts';

export type { Sql, SqlDatabase } from '@/storage/postgres/store-query.ts';

export function openSqlStore(db: SqlDatabase, migrate: () => Promise<void>): Store {
  const root: Sql = { query: db.query.bind(db), exec: db.exec.bind(db) };

  return {
    migrate,

    transact(work) {
      return db.transaction(tx => work(unitOfWork(tx)));
    },

    async group(workspaceId, groupId) {
      const row = await one(root, 'SELECT * FROM groups WHERE workspace_id = $1 AND id = $2', [
        workspaceId,
        groupId,
      ]);

      return oneParsed(row, parseGroup);
    },

    tasks(workspaceId, groupId) {
      return readTasks(root, workspaceId, groupId);
    },

    events(workspaceId, groupId) {
      return readEvents(root, workspaceId, groupId);
    },

    sessions(workspaceId, groupId) {
      return readSessions(root, workspaceId, groupId);
    },

    session(workspaceId, id) {
      return readSession(root, workspaceId, id);
    },

    occupancy(workspaceId, groupId) {
      return readOccupancy(root, workspaceId, groupId);
    },

    spawnCount(groupId, since) {
      return counterWork(root).spawnCount(groupId, since);
    },

    async connection(workspaceId) {
      const row = await one(root, 'SELECT id FROM connections WHERE workspace_id = $1', [
        workspaceId,
      ]);

      return row === null ? null : requireConnectionId(readString(row, 'id'));
    },

    async saveConnection(row) {
      await run(
        root,
        `INSERT INTO connections (workspace_id, id, adapter, created_at)
         VALUES ($1, $2, $3, $4::timestamptz)`,
        [row.workspaceId, row.id, row.adapter, row.createdAt]
      );
    },
  };
}

export function openPgliteStore(database: PGlite): Store {
  return openSqlStore(
    {
      transaction: work => database.transaction(tx => work(queries(tx))),
      query: (text, params) => database.query(text, params),
      exec: text => database.exec(text),
    },
    async () => {
      await database.waitReady;
      await applyMigrations(executePglite(database));
    }
  );
}

function queries(db: PGlite | Transaction): Sql {
  return {
    query(text, params) {
      return db.query(text, params);
    },
    exec(text) {
      return db.exec(text);
    },
  };
}

function unitOfWork(sql: Sql): UnitOfWork {
  return inLockOrder({
    ...counterWork(sql),
    ...rowWork(sql),
    ...codeWork(sql),
    ...accountWork(sql),
    ...groupWork(sql),
    ...taskWork(sql),
    ...messageWork(sql),
    ...jobLocks(sql),
    ...jobState(sql),
    ...jobHousekeeping(sql),
  });
}
