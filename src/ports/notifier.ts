import type { AlertRule, AlertSeverity } from '@/domain/background-jobs.ts';

/**
 * One alert as a notifier sees it: names and titles, and for an escalation the reason. The reason
 * is free text that the session wrote. It is redacted only for this service's own token formats,
 * so a notifier must be a channel that a person trusts with it.
 */
export type Notification = {
  deliveryId: string;
  sentAt: string;
  reminder: boolean;
  workspaceId: string;
  groupId: string | null;
  groupName: string | null;
  alertId: string;
  targetId: string;
  rule: AlertRule;
  severity: AlertSeverity;
  summary: string;
  action: string;
  taskTitle: string | null;
  sessionRole: string | null;
  sessionAddress: string | null;
  openFor: string;
  reason: string | null;
};

export interface Notifier {
  /** Send one notification. A rejection means it was not delivered, and the run retries it. */
  deliver(notification: Notification): Promise<void>;
}
