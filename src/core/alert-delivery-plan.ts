import type { AlertDelivery, AlertRecord } from '@/domain/background-jobs.ts';
import {
  notifyGiveUpMs,
  notifyPerRun,
  notifyRetryMaxMs,
  notifyRetryMs,
  reminderCriticalMs,
  reminderNormalMs,
  reminderStopMs,
} from '@/domain/background-jobs.ts';
import { sha256Hex } from '@/domain/secret.ts';
import { formatTime } from '@/domain/time.ts';

export type PlannedDelivery = { alert: AlertRecord; deliveryId: string };

export type DeliveryPlan = {
  /** Outstanding deliveries that are a day old, that are for an alert that is no longer open, or that are for an alert too old to be sent now. They are never sent. */
  expire: AlertDelivery[];
  /** At most {@link notifyPerRun}, critical first and then the alert that has been open longest. */
  send: PlannedDelivery[];
};

/**
 * Decide what a run sends. Due is derived from the alert and its deliveries, there is no stored
 * flag: an alert is notified once, within a day of opening, and reminded after an interval that
 * depends on its severity until it has been open for a week. An alert with an outstanding
 * delivery gets no second one, only a retry of that delivery under its own id, and a retry stops
 * once the alert is too old for the notification that delivery carries.
 *
 * <p>{@code openAlertIds} holds every open alert, whatever its rule. An alert that is open but
 * missing from {@code alerts} belongs to a newer release, so its deliveries are left alone.
 */
export function planDeliveries(
  alerts: readonly AlertRecord[],
  openAlertIds: ReadonlySet<string>,
  outstanding: readonly AlertDelivery[],
  nowMs: number
): DeliveryPlan {
  const openById = new Map(alerts.map(alert => [alert.id, alert]));
  const withOutstanding = new Set<string>();
  const expire: AlertDelivery[] = [];
  const candidates: PlannedDelivery[] = [];

  for (const delivery of outstanding) {
    const alert = openById.get(delivery.alertId);

    if (alert === undefined && openAlertIds.has(delivery.alertId)) continue;

    if (alert === undefined || tooOld(delivery, alert, nowMs)) {
      expire.push(delivery);
      continue;
    }

    withOutstanding.add(alert.id);

    if (dueForRetry(delivery, nowMs)) candidates.push({ alert, deliveryId: delivery.id });
  }

  for (const alert of alerts) {
    if (withOutstanding.has(alert.id) || !isDue(alert, nowMs)) continue;

    candidates.push({ alert, deliveryId: newDeliveryId(alert, nowMs) });
  }

  candidates.sort(criticalThenOldest);

  return { expire, send: candidates.slice(0, notifyPerRun) };
}

/** How long a delivery waits after its Nth send before it is sent again: 5 minutes, doubling, to an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(notifyRetryMs * 2 ** (attempts - 1), notifyRetryMaxMs);
}

function tooOld(delivery: AlertDelivery, alert: AlertRecord, nowMs: number): boolean {
  return nowMs - Date.parse(delivery.createdAt) >= notifyGiveUpMs || !withinAgeLimit(alert, nowMs);
}

/** A first notification is sent only within a day of opening, and a reminder only within a week. */
function withinAgeLimit(alert: AlertRecord, nowMs: number): boolean {
  const openFor = nowMs - Date.parse(alert.openedAt);

  return openFor < (alert.notifiedAt === null ? notifyGiveUpMs : reminderStopMs);
}

function dueForRetry(delivery: AlertDelivery, nowMs: number): boolean {
  return nowMs - Date.parse(delivery.updatedAt) >= retryDelayMs(delivery.attempts);
}

function isDue(alert: AlertRecord, nowMs: number): boolean {
  if (!withinAgeLimit(alert, nowMs)) return false;
  if (alert.notifiedAt === null) return true;

  const interval = alert.severity === 'critical' ? reminderCriticalMs : reminderNormalMs;

  return nowMs - Date.parse(alert.notifiedAt) >= interval;
}

/** Fixed when the delivery is first recorded, so a retry keeps it and a reminder gets a new one. */
function newDeliveryId(alert: AlertRecord, nowMs: number): string {
  return sha256Hex(`${alert.id}:${alert.notifiedAt ?? 'first'}:${formatTime(new Date(nowMs))}`);
}

function criticalThenOldest(left: PlannedDelivery, right: PlannedDelivery): number {
  if (left.alert.severity !== right.alert.severity) {
    return left.alert.severity === 'critical' ? -1 : 1;
  }

  const byAge = Date.parse(left.alert.openedAt) - Date.parse(right.alert.openedAt);

  return byAge !== 0 ? byAge : left.deliveryId.localeCompare(right.deliveryId);
}
