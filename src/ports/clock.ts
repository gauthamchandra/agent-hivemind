export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now() {
    return new Date();
  },
};

export type ManualClock = Clock & {
  advance(milliseconds: number): void;
  set(next: Date): void;
};

export function manualClock(start: Date): ManualClock {
  let current = start.getTime();

  return {
    now() {
      return new Date(current);
    },
    advance(milliseconds) {
      current += milliseconds;
    },
    set(next) {
      current = next.getTime();
    },
  };
}
