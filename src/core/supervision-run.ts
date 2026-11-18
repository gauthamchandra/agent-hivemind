import type { ServiceDeps } from '@/core/deps.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { WorkspaceId } from '@/domain/ids.ts';
import type { JobName } from '@/domain/supervision.ts';
import { leaseMs } from '@/domain/supervision.ts';
import { formatTime } from '@/domain/time.ts';

export type RunOptions = {
  workerId: string;
  halt?: 'after_intent';
};

export type TickResult = {
  ran: boolean;
  epoch: number | null;
};

/** The run recorded an intent and then stopped, before the platform call. */
export class SupervisionHalted extends Error {
  readonly epoch: number;
  readonly intentId: string;

  constructor(epoch: number, intentId: string) {
    super('The supervision run stopped after it recorded an intent.');
    this.name = 'SupervisionHalted';
    this.epoch = epoch;
    this.intentId = intentId;
  }
}

/** A different string for each process, stored as `leases.holder`. */
export function createWorkerId(bytes: Uint8Array): string {
  return `hivemind-svc:${Buffer.from(bytes).toString('hex')}`;
}

export async function takeJob(
  deps: ServiceDeps,
  job: JobName,
  workerId: string,
  intervalMs: number
): Promise<number | null> {
  const nowMs = deps.clock.now().getTime();
  const started = await deps.store.transact(tx => tx.leaseStartedAt(job));

  if (started !== null && Date.parse(started) > nowMs - intervalMs) return null;

  return deps.store.transact(tx =>
    tx.takeLease({
      job,
      holder: workerId,
      now: formatTime(new Date(nowMs)),
      expiresAt: formatTime(new Date(nowMs + leaseMs)),
      dueAt: formatTime(new Date(nowMs - intervalMs)),
    })
  );
}

export async function recordIntent(
  deps: ServiceDeps,
  options: RunOptions,
  job: JobName,
  epoch: number,
  action: string,
  targetId: string,
  workspaceId: WorkspaceId
): Promise<string> {
  const now = formatTime(deps.clock.now());
  const id = `${job}:${action}:${targetId}:${epoch}`;
  const outcome = await deps.store.transact(tx =>
    tx.insertIntent({ id, job, action, targetId, workspaceId, epoch, now })
  );

  if (outcome === 'stale') {
    throw new HivemindError('conflict', 'The lease epoch is no longer current.');
  }

  if (outcome === 'open') {
    const rows = await deps.store.transact(tx => tx.openIntents(job));
    const open = rows.find(row => row.action === action && row.targetId === targetId);

    if (open === undefined) {
      throw new HivemindError('conflict', 'The open intent disappeared.');
    }

    return open.id;
  }

  if (options.halt === 'after_intent') throw new SupervisionHalted(epoch, id);

  return id;
}

export async function finishRecordedIntent(
  deps: ServiceDeps,
  job: JobName,
  epoch: number,
  intentId: string
): Promise<void> {
  const now = formatTime(deps.clock.now());
  const finished = await deps.store.transact(tx => tx.finishIntent(intentId, job, epoch, now));

  if (!finished) throw new HivemindError('conflict', 'The lease epoch is no longer current.');
}
