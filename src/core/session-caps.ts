import { HivemindError } from '@/domain/errors.ts';
import type { SessionRole } from '@/domain/model.ts';
import type { OccupancyDelta } from '@/ports/storage.ts';

export function occupancyFor(role: SessionRole, live: number, total: number): OccupancyDelta {
  return {
    live_sessions: live,
    planner: role === 'planner' ? live : 0,
    challenger: role === 'challenger' ? live : 0,
    implementer: role === 'implementer' ? live : 0,
    total_sessions: total,
  };
}

export function reach(cap: string, limit: number | string, current: number | string): never {
  throw new HivemindError(
    'cap_reached',
    `The ${cap} cap is ${limit}. The current value is ${current}.`,
    {
      cap,
      limit,
      current,
    }
  );
}
