import type {
  CopyId,
  GroupId,
  MessageId,
  SessionId,
  TaskId,
  WaitId,
  WorkspaceId,
} from '@/domain/ids.ts';
export const messageKinds = [
  'note',
  'question',
  'answer',
  'instruction',
  'relayed_instruction',
] as const;
export type MessageKind = (typeof messageKinds)[number];

export const dropReasons = [
  'recipient_ended',
  'recipient_unknown_to_platform',
  'platform_rejected',
  'expired',
  'recipient_start_failed',
] as const;
export type DropReason = (typeof dropReasons)[number];

export const copyStates = ['queued', 'claimed', 'delivered', 'dropped'] as const;
export type CopyState = (typeof copyStates)[number];

export const bodyLimit = 16 * 1024;
export const senderLimit = 10;
export const senderWindowMs = 60 * 1000;
export const broadcastLimit = 3;
export const broadcastWindowMs = 10 * 60 * 1000;
export const openQuestionLimit = 5;
export const defaultWaitSeconds = 5 * 60;
export const minWaitSeconds = 1;
export const maxWaitSeconds = 24 * 60 * 60;
export const claimMs = 60 * 1000;
export const outboxTtlMs = 24 * 60 * 60 * 1000;
export const busyDelayMs = 30 * 1000;
export const busyAttempts = 20;
export const pauseDelayMs = 30 * 1000;
export const callsPerMinute = 60;
export const messageCallCeiling = Math.floor(callsPerMinute * 0.8);
export const mailLogLimit = 10_000;
export const credentialMarker = '[redacted-credential]';
export const deliveredMeans =
  'Delivered means that the platform accepted the message. It does not mean that the session read it.';

const credentialShape = /(?:ses|enr|opk)_[A-Za-z0-9_-]{43}/g;

export type MessageAudience = 'one' | 'all' | 'none';

export type MessageRecord = {
  id: MessageId;
  workspace_id: WorkspaceId;
  group_id: GroupId;
  sender_kind: 'session' | 'person';
  sender_id: string;
  sender_role: string;
  sender_task_id: TaskId;
  kind: MessageKind;
  audience: MessageAudience;
  in_reply_to: MessageId | null;
  body: string;
  idempotency_key: string;
  created_at: string;
};

export type OutboxCopy = {
  id: CopyId;
  workspace_id: WorkspaceId;
  group_id: GroupId;
  connection_id: string;
  message_id: MessageId;
  recipient_id: SessionId;
  sequence: number;
  claim_generation: number;
  state: CopyState;
  attempts: number;
  busy_streak: number;
  next_attempt_at: string;
  claimed_by: string | null;
  claimed_until: string | null;
  outcome_reason: DropReason | null;
  platform_reference: string | null;
  created_at: string;
  delivered_at: string | null;
};

export type WaitRecord = {
  id: WaitId;
  workspace_id: WorkspaceId;
  group_id: GroupId;
  waiting_session_id: SessionId;
  awaited_session_id: SessionId;
  question_id: MessageId | null;
  deadline_at: string;
  created_at: string;
  cleared_at: string | null;
};

export type ClaimedDelivery = {
  copy: OutboxCopy;
  recipientRef: string;
  senderKind: 'session' | 'person';
  senderId: string;
  senderRole: string;
  senderTaskId: TaskId;
  kind: MessageKind;
  body: string;
  inReplyTo: MessageId | null;
};

export type DroppedCopy = {
  messageId: MessageId;
  recipientId: SessionId;
  workspaceId: WorkspaceId;
  groupId: GroupId;
  taskId: TaskId;
  reason: DropReason;
};

export function isMessageKind(value: string): value is MessageKind {
  return messageKinds.some(kind => kind === value);
}

export function isDropReason(value: string): value is DropReason {
  return dropReasons.some(reason => reason === value);
}

export function isCopyState(value: string): value is CopyState {
  return copyStates.some(state => state === value);
}

/** Replace a session token, enrollment code, or operator key before the body is stored. */
export function redactCredentials(body: string): string {
  return body.replace(credentialShape, credentialMarker);
}

/**
 * The text the platform session reads. The message id is in the header so a
 * repeated delivery of the same copy is visible to the recipient.
 */
export function deliveryText(input: {
  senderKind: 'session' | 'person';
  senderId: string;
  senderRole: string;
  senderTaskId: string;
  kind: MessageKind;
  messageId: string;
  inReplyTo: string | null;
  body: string;
}): string {
  const lines = [
    input.kind === 'instruction' ? 'Instruction from the owner.' : null,
    input.kind === 'relayed_instruction'
      ? `Session ${input.senderId} reports that a person said.`
      : null,
    `From ${input.senderRole} on ${input.senderTaskId} (${input.senderId})`,
    `Kind: ${input.kind}`,
    `Message: ${input.messageId}`,
    input.inReplyTo === null ? null : `Question: ${input.inReplyTo}`,
    replyCommand(input),
    '--- message from another session ---',
    input.body,
    input.kind === 'question' ? 'A partial answer is acceptable.' : null,
  ];

  return lines.filter(line => line !== null).join('\n');
}

function replyCommand(input: {
  senderKind: 'session' | 'person';
  senderId: string;
  kind: MessageKind;
  messageId: string;
}): string | null {
  if (input.senderKind !== 'session') return null;

  if (input.kind === 'question') {
    return `Reply: hivemind answer --message ${input.messageId} --to ${input.senderId}`;
  }

  return `Reply: hivemind send --to ${input.senderId}`;
}
