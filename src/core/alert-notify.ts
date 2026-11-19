import { type PlannedDelivery, planDeliveries } from '@/core/alert-delivery-plan.ts';
import { alertWords } from '@/core/alert-text.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import type { RunOptions } from '@/core/job-run.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import type { AlertDelivery, AlertRecord, JobSnapshot } from '@/domain/background-jobs.ts';
import { webhookTimeoutMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import { formatTime } from '@/domain/time.ts';
import type { Notification, Notifier } from '@/ports/notifier.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

type Context = Pick<JobSnapshot, 'groups' | 'tasks' | 'sessions'>;

/**
 * Send the notifications that the open alerts are due, at the end of a usage poll run.
 *
 * <p>With no notifier nothing is read or written, and the alert row stays the console inbox. A
 * delivery is recorded under the run's lock id before anything is sent, so a worker that lost the
 * lock sends nothing, and the result and an expiry are written under it as well. The names in a
 * notification are read only when something is sent. The sends of a run go out together, and each
 * is cut off after {@code deadlineMs}. A notifier that fails or hangs never fails the run: its
 * delivery is marked failed and is retried later, after a wait that doubles from five minutes.
 */
export async function deliverAlerts(
  deps: ServiceDeps,
  options: RunOptions,
  lockId: number,
  deadlineMs: number = webhookTimeoutMs
): Promise<void> {
  if (options.notifier === undefined) return;

  try {
    await sendDueNotifications(deps, options.notifier, lockId, deadlineMs);
  } catch (error) {
    if (error instanceof StoppedProcess) throw error;
    if (error instanceof HivemindError && error.code === 'conflict') throw error;

    console.error(
      'Alert delivery stopped early. The alerts still due are tried on the next run.',
      error
    );
  }
}

/** The notification for one alert, with the names a person needs and nothing else. */
export function toNotification(
  context: Context,
  alert: AlertRecord,
  deliveryId: string,
  reminder: boolean,
  sentAt: string
): Notification {
  const words = alertWords(alert.rule);
  const group = context.groups.find(item => item.id === alert.groupId);
  const session = context.sessions.find(item => item.id === alert.targetId);
  const task = context.tasks.find(item => item.id === (session?.task_id ?? alert.targetId));
  const minutes = Math.max(
    0,
    Math.floor((Date.parse(sentAt) - Date.parse(alert.openedAt)) / 60000)
  );
  const openFor = minutes === 1 ? '1 minute' : `${minutes} minutes`;

  return {
    deliveryId,
    sentAt,
    reminder,
    workspaceId: alert.workspaceId,
    groupId: alert.groupId,
    groupName: group?.name ?? null,
    alertId: alert.id,
    targetId: alert.targetId,
    rule: alert.rule,
    severity: alert.severity,
    summary: words.summary,
    action: words.action,
    taskTitle: task?.title ?? null,
    sessionRole: session?.role ?? null,
    sessionAddress: session?.platform_address ?? null,
    openFor,
    reason: alert.reason,
  };
}

async function sendDueNotifications(
  deps: ServiceDeps,
  notifier: Notifier,
  lockId: number,
  deadlineMs: number
): Promise<void> {
  const { alerts, openAlertIds, outstanding } = await deps.store.transact(async tx => ({
    alerts: await tx.openAlerts(),
    openAlertIds: new Set(await tx.openAlertIds()),
    outstanding: await tx.outstandingAlertDeliveries(),
  }));
  const plan = planDeliveries(alerts, openAlertIds, outstanding, deps.clock.now().getTime());

  for (const delivery of plan.expire) await expire(deps, delivery, lockId);

  logDropped(plan.expire.filter(delivery => openAlertIds.has(delivery.alertId)).length);
  for (const planned of plan.send) await record(deps, planned, lockId);

  if (plan.send.length === 0) return;

  const context = await deps.store.transact(tx => tx.loadJobSnapshot());
  const sentAt = formatTime(deps.clock.now());
  const results = await Promise.allSettled(
    plan.send.map(planned =>
      withinDeadline(
        notifier.deliver(
          toNotification(
            context,
            planned.alert,
            planned.deliveryId,
            planned.alert.notifiedAt !== null,
            sentAt
          )
        ),
        deadlineMs
      )
    )
  );

  for (const [index, result] of results.entries()) {
    const planned = plan.send[index];

    if (planned !== undefined) await finishOrLeaveSending(deps, planned, result, lockId);
  }
}

function logDropped(count: number): void {
  if (count === 0) return;

  console.warn(
    `${count} notifications were dropped without being sent, because they were a day old or their alert is too old for them. The alerts stay open in the inbox.`
  );
}

async function finishOrLeaveSending(
  deps: ServiceDeps,
  planned: PlannedDelivery,
  result: PromiseSettledResult<void>,
  lockId: number
): Promise<void> {
  try {
    await finish(deps, planned, result, lockId);
  } catch (error) {
    if (error instanceof StoppedProcess) throw error;
    if (error instanceof HivemindError && error.code === 'conflict') throw error;

    console.warn(
      `The result of a notification for a ${planned.alert.rule} alert could not be written. The delivery stays marked sending, and the notification is sent again under the same id after the wait.`,
      error
    );
  }
}

async function expire(deps: ServiceDeps, delivery: AlertDelivery, lockId: number): Promise<void> {
  await deps.store.transact(async tx => {
    const now = await holdJobLock(deps, tx, lockId);

    await tx.finishAlertDelivery(delivery.id, 'expired', now);
  });
}

async function record(deps: ServiceDeps, planned: PlannedDelivery, lockId: number): Promise<void> {
  await deps.store.transact(async tx => {
    const now = await holdJobLock(deps, tx, lockId);

    await tx.recordAlertDeliveryAttempt({
      id: planned.deliveryId,
      workspaceId: planned.alert.workspaceId,
      alertId: planned.alert.id,
      now,
    });
  });
}

async function finish(
  deps: ServiceDeps,
  planned: PlannedDelivery,
  result: PromiseSettledResult<void>,
  lockId: number
): Promise<void> {
  if (result.status === 'rejected') {
    const cause = result.reason instanceof Error ? result.reason.message : 'unknown error';

    console.warn(
      `A notification for a ${planned.alert.rule} alert was not delivered: ${cause} It will be retried later, after a wait that grows, until it is too old to send.`
    );
  }

  await deps.store.transact(async tx => {
    const now = await holdJobLock(deps, tx, lockId);

    await tx.finishAlertDelivery(
      planned.deliveryId,
      result.status === 'fulfilled' ? 'sent' : 'failed',
      now
    );
  });
}

async function holdJobLock(deps: ServiceDeps, tx: UnitOfWork, lockId: number): Promise<string> {
  const now = formatTime(deps.clock.now());

  if (!(await tx.holdJobLock('usage_poll', lockId, now))) {
    throw new HivemindError('conflict', 'This worker no longer holds the job lock.');
  }

  return now;
}

async function withinDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('The notifier did not answer in time.')), deadlineMs);
  });

  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
