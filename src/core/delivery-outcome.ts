import type { ServiceDeps } from '@/core/deps.ts';
import type { ClaimedDelivery, DropReason } from '@/domain/message.ts';
import { busyAttempts, busyDelayMs, pauseDelayMs } from '@/domain/message.ts';
import type { PlatformError, SendResult } from '@/domain/platform.ts';

export type Outcome = {
  state: 'queued' | 'delivered' | 'dropped';
  attempts: number;
  busyStreak: number;
  delayMs: number;
  reason: DropReason | null;
  pauseMs: number | null;
};

export function outcomeOf(result: SendResult, claimed: ClaimedDelivery): Outcome {
  const attempts = claimed.copy.attempts + 1;

  switch (result) {
    case 'accepted':
      return {
        state: 'delivered',
        attempts,
        busyStreak: 0,
        delayMs: 0,
        reason: null,
        pauseMs: null,
      };
    case 'busy': {
      const streak = claimed.copy.busy_streak + 1;

      return {
        state: 'queued',
        attempts: streak % busyAttempts === 0 ? attempts : claimed.copy.attempts,
        busyStreak: streak,
        delayMs: busyDelayMs,
        reason: null,
        pauseMs: null,
      };
    }
    case 'rate_limited':
      return {
        state: 'queued',
        attempts,
        busyStreak: 0,
        delayMs: pauseDelayMs,
        reason: null,
        pauseMs: pauseDelayMs,
      };
    case 'gone':
      return {
        state: 'dropped',
        attempts,
        busyStreak: 0,
        delayMs: 0,
        reason: 'recipient_unknown_to_platform',
        pauseMs: null,
      };
  }
}

export function outcomeOfError(
  error: PlatformError,
  claimed: ClaimedDelivery,
  deps: ServiceDeps
): Outcome {
  const attempts = claimed.copy.attempts + 1;

  switch (error.errorClass) {
    case 'unavailable':
      return {
        state: 'queued',
        attempts,
        busyStreak: 0,
        delayMs: backoffMs(attempts, deps),
        reason: null,
        pauseMs: null,
      };
    case 'rate_limited': {
      const pauseMs = (error.retryAfterSeconds ?? pauseDelayMs / 1000) * 1000;

      return { state: 'queued', attempts, busyStreak: 0, delayMs: pauseMs, reason: null, pauseMs };
    }
    case 'not_found':
      return {
        state: 'dropped',
        attempts,
        busyStreak: 0,
        delayMs: 0,
        reason: 'recipient_unknown_to_platform',
        pauseMs: null,
      };
    case 'auth':
    case 'quota':
    case 'invalid':
      return {
        state: 'dropped',
        attempts,
        busyStreak: 0,
        delayMs: 0,
        reason: 'platform_rejected',
        pauseMs: null,
      };
  }
}

function backoffMs(attempts: number, deps: ServiceDeps): number {
  const base = Math.min(5 * 60 * 1000, 5_000 * 2 ** Math.max(0, attempts - 1));
  const swing = Math.floor(base * 0.2);
  const byte = deps.random.bytes(1)[0] ?? 0;

  if (swing === 0) return base;

  return base + (byte % (swing * 2 + 1)) - swing;
}
