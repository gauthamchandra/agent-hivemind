import type { UnitOfWork } from '@/ports/storage.ts';
import { codeWork } from '@/storage/postgres/session-codes.ts';
import { counterWork } from '@/storage/postgres/session-counters.ts';
import { rowWork } from '@/storage/postgres/session-row-work.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';

export function sessionUnit(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'occupancy'
  | 'addOccupancy'
  | 'spawnCount'
  | 'insertSpawn'
  | 'holderCount'
  | 'liveOnTask'
  | 'replacementCount'
  | 'nextAttempt'
  | 'implementerEverStarted'
  | 'insertSession'
  | 'updateSession'
  | 'lockSession'
  | 'sessionById'
  | 'sessionByTokenHash'
  | 'sessionByEndReceipt'
  | 'touchReport'
  | 'insertEnrollmentCode'
  | 'enrollmentByHash'
  | 'openEnrollmentCode'
  | 'saveEnrollmentCode'
  | 'voidEnrollmentCodes'
  | 'findIdempotency'
  | 'insertIdempotency'
> {
  return {
    ...counterWork(sql),
    ...rowWork(sql),
    ...codeWork(sql),
  };
}

export { readOccupancy, readSession, readSessions } from '@/storage/postgres/session-read.ts';
