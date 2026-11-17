import type { IdFactory, PersonId, SessionId } from '@/domain/ids.ts';
import type { SessionRole } from '@/domain/model.ts';
import type { Clock } from '@/ports/clock.ts';
import type { RandomSource } from '@/ports/random.ts';
import type { Store } from '@/ports/storage.ts';

export type ServiceDeps = {
  store: Store;
  clock: Clock;
  random: RandomSource;
  ids: IdFactory;
};

export type ReportActor =
  | { kind: 'session'; role: SessionRole; sessionId: SessionId; live: boolean }
  | { kind: 'person'; personId: PersonId }
  | { kind: 'service' };
