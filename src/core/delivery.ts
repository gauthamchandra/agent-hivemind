import { appendEvent } from '@/core/append-event.ts';
import { type Outcome, outcomeOf, outcomeOfError } from '@/core/delivery-outcome.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import type { ConnectionId, SessionId } from '@/domain/ids.ts';
import { requireConnectionId } from '@/domain/ids.ts';
import type { ClaimedDelivery, DroppedCopy } from '@/domain/message.ts';
import { claimMs, deliveryText, messageCallCeiling, outboxTtlMs } from '@/domain/message.ts';
import { PlatformError } from '@/domain/platform.ts';
import { formatTime } from '@/domain/time.ts';
import type { Platforms } from '@/ports/platform.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

export type DeliveryHalt = 'before_send' | 'after_accept';

/** The worker stopped between two committed steps. The copy stays claimed until the claim expires. */
export class DeliveryStopped extends Error {
  readonly point: DeliveryHalt;

  constructor(point: DeliveryHalt) {
    super(`The delivery worker stopped at ${point}.`);
    this.name = 'DeliveryStopped';
    this.point = point;
  }
}

export async function drainOutbox(
  deps: ServiceDeps,
  platforms: Platforms,
  options: { workerId: string; halt?: DeliveryHalt }
): Promise<void> {
  for (;;) {
    await deps.store.transact(tx => sweep(deps, tx));

    const claimed = await deps.store.transact(tx => {
      const now = formatTime(deps.clock.now());
      const until = formatTime(new Date(deps.clock.now().getTime() + claimMs));

      return tx.claimDelivery(options.workerId, now, until);
    });

    if (claimed === null) return;

    const allowed = await deps.store.transact(tx =>
      tx.takeMessageBudget(
        claimed.copy.connection_id,
        minuteStart(deps.clock.now()),
        messageCallCeiling
      )
    );

    if (!allowed) {
      await deps.store.transact(tx =>
        tx.settleCopy({
          id: claimed.copy.id,
          generation: claimed.copy.claim_generation,
          state: 'queued',
          attempts: claimed.copy.attempts,
          busyStreak: claimed.copy.busy_streak,
          nextAttemptAt: nextMinute(deps.clock.now()),
          reason: null,
          deliveredAt: null,
        })
      );
      continue;
    }

    if (options.halt === 'before_send') throw new DeliveryStopped('before_send');

    const outcome = await askPlatform(deps, platforms, claimed);

    if (options.halt === 'after_accept') throw new DeliveryStopped('after_accept');

    await deps.store.transact(tx => applyOutcome(deps, tx, claimed, outcome));
  }
}

export async function settleRecipientMail(
  deps: ServiceDeps,
  tx: UnitOfWork,
  sessionId: SessionId
): Promise<void> {
  await tx.clearSessionWaits(sessionId, formatTime(deps.clock.now()));
  await recordDrops(deps, tx, await tx.dropUnavailableCopies(sessionId));
}

async function sweep(deps: ServiceDeps, tx: UnitOfWork): Promise<void> {
  const nowMs = deps.clock.now().getTime();
  const now = formatTime(new Date(nowMs));
  const deadline = formatTime(new Date(nowMs - outboxTtlMs));

  await tx.lockGroupsWithOutbox(deadline);
  await tx.releaseExpiredClaims(now);
  const expired = await tx.dropExpiredCopies(deadline);
  const unavailable = await tx.dropUnavailableCopies();

  await recordDrops(deps, tx, [...expired, ...unavailable]);
}

async function askPlatform(
  deps: ServiceDeps,
  platforms: Platforms,
  claimed: ClaimedDelivery
): Promise<Outcome> {
  const handle = platforms.require(connectionId(claimed.copy.connection_id));
  const text = deliveryText({
    senderKind: claimed.senderKind,
    senderId: claimed.senderId,
    senderRole: claimed.senderRole,
    senderTaskId: claimed.senderTaskId,
    kind: claimed.kind,
    messageId: claimed.copy.message_id,
    inReplyTo: claimed.inReplyTo,
    body: claimed.body,
  });

  try {
    return outcomeOf(
      await handle.adapter.send(handle.connection, claimed.recipientRef, text),
      claimed
    );
  } catch (error) {
    if (error instanceof PlatformError) return outcomeOfError(error, claimed, deps);

    throw error;
  }
}

function connectionId(value: string): ConnectionId {
  return requireConnectionId(value);
}

async function applyOutcome(
  deps: ServiceDeps,
  tx: UnitOfWork,
  claimed: NonNullable<Awaited<ReturnType<UnitOfWork['claimDelivery']>>>,
  outcome: Outcome
): Promise<void> {
  const nowMs = deps.clock.now().getTime();
  const dropping = outcome.state === 'dropped' && outcome.reason !== null;

  if (dropping) await tx.lockGroup(claimed.copy.workspace_id, claimed.copy.group_id);

  const recipient = dropping
    ? await tx.lockSession(claimed.copy.workspace_id, claimed.copy.recipient_id)
    : null;

  if (outcome.pauseMs !== null) {
    await tx.pauseConnection(
      claimed.copy.connection_id,
      formatTime(new Date(nowMs + outcome.pauseMs))
    );
  }

  const wrote = await tx.settleCopy({
    id: claimed.copy.id,
    generation: claimed.copy.claim_generation,
    state: outcome.state,
    attempts: outcome.attempts,
    busyStreak: outcome.busyStreak,
    nextAttemptAt: formatTime(new Date(nowMs + outcome.delayMs)),
    reason: outcome.reason,
    deliveredAt: outcome.state === 'delivered' ? formatTime(new Date(nowMs)) : null,
  });

  if (!wrote || recipient === null || outcome.reason === null) return;

  await appendEvent(deps, tx, {
    workspace_id: recipient.workspace_id,
    task_id: recipient.task_id,
    group_id: recipient.group_id,
    kind: 'message_dropped',
    actor: { kind: 'service', id: 'hivemind-svc' },
    from_state: null,
    to_state: null,
    evidence: [],
    note: null,
    data: { message_id: claimed.copy.message_id, reason: outcome.reason },
  });
}

async function recordDrops(deps: ServiceDeps, tx: UnitOfWork, drops: DroppedCopy[]): Promise<void> {
  const locked = new Set<string>();

  for (const drop of drops) {
    if (!locked.has(drop.groupId)) {
      await tx.lockGroup(drop.workspaceId, drop.groupId);
      locked.add(drop.groupId);
    }

    await appendEvent(deps, tx, {
      workspace_id: drop.workspaceId,
      task_id: drop.taskId,
      group_id: drop.groupId,
      kind: 'message_dropped',
      actor: { kind: 'service', id: 'hivemind-svc' },
      from_state: null,
      to_state: null,
      evidence: [],
      note: null,
      data: { message_id: drop.messageId, reason: drop.reason },
    });
  }
}

function minuteStart(now: Date): string {
  const ms = now.getTime();

  return formatTime(new Date(ms - (ms % 60_000)));
}

function nextMinute(now: Date): string {
  return formatTime(new Date(now.getTime() - (now.getTime() % 60_000) + 60_000));
}
