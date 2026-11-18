import { HivemindError } from '@/domain/errors.ts';

const crockford = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const body = '[0-9A-HJKMNP-TV-Z]{26}';

export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' };
export type GroupId = string & { readonly __brand: 'GroupId' };
export type TaskId = string & { readonly __brand: 'TaskId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type PersonId = string & { readonly __brand: 'PersonId' };
export type OperatorKeyId = string & { readonly __brand: 'OperatorKeyId' };
export type ConnectionId = string & { readonly __brand: 'ConnectionId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type ChangesetId = string & { readonly __brand: 'ChangesetId' };
export type MessageId = string & { readonly __brand: 'MessageId' };
export type WaitId = string & { readonly __brand: 'WaitId' };
export type CopyId = string & { readonly __brand: 'CopyId' };
export type FindingId = string & { readonly __brand: 'FindingId' };

export type IdClock = { now(): Date };
export type IdRandom = { bytes(length: number): Uint8Array };

export type IdFactory = {
  workspace(): WorkspaceId;
  group(): GroupId;
  task(): TaskId;
  event(): EventId;
  person(): PersonId;
  operatorKey(): OperatorKeyId;
  connection(): ConnectionId;
  session(): SessionId;
  changeset(): ChangesetId;
  message(): MessageId;
  wait(): WaitId;
  copy(): CopyId;
  finding(): FindingId;
};

const patterns = {
  workspace: new RegExp(`^ws_${body}$`),
  group: new RegExp(`^grp_${body}$`),
  task: new RegExp(`^tsk_${body}$`),
  event: new RegExp(`^evt_${body}$`),
  person: new RegExp(`^per_${body}$`),
  operatorKey: new RegExp(`^opk_${body}$`),
  connection: new RegExp(`^con_${body}$`),
  session: new RegExp(`^ses_${body}$`),
  changeset: new RegExp(`^chg_${body}$`),
  message: new RegExp(`^msg_${body}$`),
  wait: new RegExp(`^wat_${body}$`),
  copy: new RegExp(`^cpy_${body}$`),
  finding: new RegExp(`^fnd_${body}$`),
} as const;

export function isWorkspaceId(value: string): value is WorkspaceId {
  return value === 'ws_default' || patterns.workspace.test(value);
}

export function isGroupId(value: string): value is GroupId {
  return patterns.group.test(value);
}

export function isTaskId(value: string): value is TaskId {
  return patterns.task.test(value);
}

export function isEventId(value: string): value is EventId {
  return patterns.event.test(value);
}

export function isPersonId(value: string): value is PersonId {
  return patterns.person.test(value);
}

export function isOperatorKeyId(value: string): value is OperatorKeyId {
  return patterns.operatorKey.test(value);
}

export function isConnectionId(value: string): value is ConnectionId {
  return patterns.connection.test(value);
}

export function isSessionId(value: string): value is SessionId {
  return patterns.session.test(value);
}

export function isChangesetId(value: string): value is ChangesetId {
  return patterns.changeset.test(value);
}

export function isMessageId(value: string): value is MessageId {
  return patterns.message.test(value);
}

export function isWaitId(value: string): value is WaitId {
  return patterns.wait.test(value);
}

export function isCopyId(value: string): value is CopyId {
  return patterns.copy.test(value);
}

export function isFindingId(value: string): value is FindingId {
  return patterns.finding.test(value);
}

export function requireWorkspaceId(value: string): WorkspaceId {
  return brand(value, isWorkspaceId, 'workspace');
}

export function requireGroupId(value: string): GroupId {
  return brand(value, isGroupId, 'group');
}

export function requireTaskId(value: string): TaskId {
  return brand(value, isTaskId, 'task');
}

export function requireEventId(value: string): EventId {
  return brand(value, isEventId, 'event');
}

export function requirePersonId(value: string): PersonId {
  return brand(value, isPersonId, 'person');
}

export function requireOperatorKeyId(value: string): OperatorKeyId {
  return brand(value, isOperatorKeyId, 'operator key');
}

export function requireConnectionId(value: string): ConnectionId {
  return brand(value, isConnectionId, 'connection');
}

export function requireSessionId(value: string): SessionId {
  return brand(value, isSessionId, 'session');
}

export function requireChangesetId(value: string): ChangesetId {
  return brand(value, isChangesetId, 'changeset');
}

export function requireMessageId(value: string): MessageId {
  return brand(value, isMessageId, 'message');
}

export function requireWaitId(value: string): WaitId {
  return brand(value, isWaitId, 'wait');
}

export function requireCopyId(value: string): CopyId {
  return brand(value, isCopyId, 'copy');
}

export function requireFindingId(value: string): FindingId {
  return brand(value, isFindingId, 'finding');
}

/** The self-hosted installation's first workspace. The identifier is fixed by the specification. */
export const defaultWorkspaceId = requireWorkspaceId('ws_default');

/**
 * Mint prefixed sortable ids. Within one millisecond the random suffix increases,
 * so ids created by one factory sort in creation order.
 */
export function createIds(clock: IdClock, random: IdRandom): IdFactory {
  let lastMs = -1;
  let lastRandom = new Uint8Array(10);

  const mint = (prefix: string): string => {
    const ms = clock.now().getTime();

    if (!Number.isSafeInteger(ms) || ms < 0) {
      throw new HivemindError(
        'unavailable',
        'The clock returned a time that cannot be an identifier.'
      );
    }

    if (ms === lastMs) {
      increment(lastRandom);
    } else {
      lastMs = ms;
      const drawn = random.bytes(10);

      if (drawn.length !== 10) {
        throw new HivemindError(
          'unavailable',
          'The random source returned the wrong number of bytes.'
        );
      }

      lastRandom = Uint8Array.from(drawn);
    }

    return `${prefix}${encodeTime(ms)}${encodeRandom(lastRandom)}`;
  };

  return {
    workspace: () => requireWorkspaceId(mint('ws_')),
    group: () => requireGroupId(mint('grp_')),
    task: () => requireTaskId(mint('tsk_')),
    event: () => requireEventId(mint('evt_')),
    person: () => requirePersonId(mint('per_')),
    operatorKey: () => requireOperatorKeyId(mint('opk_')),
    connection: () => requireConnectionId(mint('con_')),
    session: () => requireSessionId(mint('ses_')),
    changeset: () => requireChangesetId(mint('chg_')),
    message: () => requireMessageId(mint('msg_')),
    wait: () => requireWaitId(mint('wat_')),
    copy: () => requireCopyId(mint('cpy_')),
    finding: () => requireFindingId(mint('fnd_')),
  };
}

function brand<T extends string>(
  value: string,
  predicate: (input: string) => input is T,
  kind: string
): T {
  if (!predicate(value)) {
    throw new HivemindError('validation_failed', `The ${kind} identifier is not valid.`, {
      field: 'id',
    });
  }

  return value;
}

function encodeTime(ms: number): string {
  let value = ms;
  const chars = Array.from({ length: 10 }, () => '0');

  for (let index = 9; index >= 0; index -= 1) {
    chars[index] = crockford[value % 32] ?? '0';
    value = Math.floor(value / 32);
  }

  if (value !== 0) {
    throw new HivemindError(
      'unavailable',
      'The clock returned a time that cannot be an identifier.'
    );
  }

  return chars.join('');
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  const chars = Array.from({ length: 16 }, () => '0');

  for (let index = 15; index >= 0; index -= 1) {
    chars[index] = crockford[Number(value & 31n)] ?? '0';
    value >>= 5n;
  }

  return chars.join('');
}

function increment(bytes: Uint8Array): void {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];

    if (byte === undefined) continue;

    if (byte < 255) {
      bytes[index] = byte + 1;
      return;
    }

    bytes[index] = 0;
  }

  throw new HivemindError(
    'unavailable',
    'The identifier factory ran out of values for this millisecond.'
  );
}
