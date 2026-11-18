import type { FindingSeverity } from '@/domain/supervision.ts';

/** One finding as a notifier sees it. Names and titles only: no message body, prompt, or token. */
export type NotificationFinding = {
  id: string;
  rule: string;
  severity: FindingSeverity;
  words: string;
  groupName: string;
  taskTitle: string | null;
  role: string | null;
  openFor: string;
  action: string;
  reason: string | null;
  sessionAddress: string | null;
};

export type NotificationRecipient = {
  kind: 'owner' | 'administrator';
  id: string;
  subject: string | null;
  address: string | null;
};

/** One delivery to one recipient. The delivery id is stable across a retry. */
export type Notification = {
  deliveryId: string;
  workspaceId: string;
  sentAt: string;
  recipient: NotificationRecipient;
  findings: NotificationFinding[];
};

export interface Notifier {
  deliver(notification: Notification): Promise<void>;
}
