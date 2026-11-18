import type { NeutralStatus, SessionRole } from '@/domain/model.ts';
import { isNeutralStatus } from '@/domain/model.ts';
import {
  type Capability,
  PlatformError,
  type PlatformErrorClass,
  type SendResult,
} from '@/domain/platform.ts';
import type {
  AdapterDescription,
  FindResult,
  StartSessionInput,
  StartSessionResult,
} from '@/ports/platform.ts';

export type SimSession = {
  key: string;
  ref: string;
  address: string;
  prompt: string;
  secret: string | null;
  rawStatus: string;
  usageFloor: number;
  reported: number | null;
  ended: boolean;
};

export type SentPlatformMessage = {
  ref: string;
  body: string;
  statusAtSend: string;
  result: SendResult;
};

export type SimWorld = {
  enabled: Set<Capability>;
  sessions: SimSession[];
  logs: string[];
  calls: string[];
  sent: SentPlatformMessage[];
  recordSent: boolean;
  queued: { operation: string; errorClass: PlatformErrorClass } | null;
  loseStart: boolean;
  sendResult: SendResult;
  reportedUsage: number;
  usageUnit: string;
  usageUnitDisplay: string;
  roleCeilings: Partial<Record<SessionRole, number>>;
  credential: string;
};

const messages: Record<PlatformErrorClass, string> = {
  auth: 'The platform refused the credential.',
  rate_limited: 'The platform asked the caller to slow.',
  quota: 'The platform account reached a limit.',
  invalid: 'The platform rejected the request.',
  not_found: 'The platform does not know that session.',
  unavailable: 'The platform did not answer.',
};

export function failIfQueued(world: SimWorld, operation: string): void {
  if (world.queued?.operation !== operation) return;

  const errorClass = world.queued.errorClass;

  world.queued = null;

  throw new PlatformError(errorClass, messages[errorClass]);
}

export function requireSession(world: SimWorld, ref: string): SimSession {
  const session = world.sessions.find(item => item.ref === ref);

  if (session === undefined) throw new PlatformError('not_found', messages.not_found);

  return session;
}

export async function probe(world: SimWorld) {
  world.calls.push('probe');
  failIfQueued(world, 'probe');

  return { capabilities: [...world.enabled] };
}

export async function start(world: SimWorld, input: StartSessionInput) {
  world.calls.push('start');
  failIfQueued(world, 'start');

  const existing = world.sessions.find(item => item.key === input.idempotencyKey);

  if (existing !== undefined && world.enabled.has('idempotent_start'))
    return started(existing, input);

  const session: SimSession = {
    key: input.idempotencyKey,
    ref: `plat_${input.idempotencyKey}`,
    address: `https://platform.example/sessions/${input.idempotencyKey}`,
    prompt: input.prompt,
    secret: input.secret?.value ?? null,
    rawStatus: 'working',
    usageFloor: 0,
    reported: null,
    ended: false,
  };

  world.sessions.push(session);

  if (world.loseStart) {
    world.loseStart = false;

    throw new PlatformError('unavailable', messages.unavailable);
  }

  return started(session, input);
}

export async function readStatus(world: SimWorld, ref: string) {
  world.calls.push('readStatus');
  failIfQueued(world, 'readStatus');

  return { status: mapped(requireSession(world, ref).rawStatus, world.logs) };
}

export async function readMany(world: SimWorld, refs: readonly string[]) {
  world.calls.push('readMany');
  failIfQueued(world, 'readMany');

  return refs.map(ref => ({
    platformSessionRef: ref,
    status: mapped(requireSession(world, ref).rawStatus, world.logs),
  }));
}

export async function send(world: SimWorld, ref: string, body: string) {
  const session = requireSession(world, ref);

  if (session.ended) {
    world.calls.push('send_suppressed');

    return 'gone';
  }

  world.calls.push('send');
  failIfQueued(world, 'send');

  // The service body is 16 KiB. Delivery adds a header in front of it, and the
  // platform accepts that envelope.
  if (Buffer.byteLength(body) > 16 * 1024 + 2048) {
    throw new PlatformError('invalid', messages.invalid);
  }

  const result = world.sendResult;
  const statusAtSend = session.rawStatus;

  if (world.recordSent) world.sent.push({ ref, body, statusAtSend, result });

  if (
    result === 'accepted' &&
    statusAtSend === 'suspended' &&
    world.enabled.has('wake_on_message')
  ) {
    session.rawStatus = 'working';
  }

  return result;
}

export async function suspend(world: SimWorld, ref: string) {
  world.calls.push('suspend');
  failIfQueued(world, 'suspend');
  requireSession(world, ref).rawStatus = 'suspended';
}

export async function end(world: SimWorld, ref: string) {
  world.calls.push('end');
  failIfQueued(world, 'end');
  const session = world.sessions.find(item => item.ref === ref);

  if (session !== undefined) {
    session.ended = true;
    session.rawStatus = 'stopped';
  }
}

export async function readUsage(world: SimWorld, ref: string) {
  world.calls.push('readUsage');
  failIfQueued(world, 'readUsage');
  const session = requireSession(world, ref);

  const reported = session.reported ?? world.reportedUsage;

  if (reported < session.usageFloor) {
    world.logs.push('A usage reading went backwards. The earlier reading was kept.');

    return session.usageFloor;
  }

  session.usageFloor = reported;

  return session.usageFloor;
}

export async function findByKey(world: SimWorld, key: string): Promise<FindResult> {
  world.calls.push('findByKey');
  failIfQueued(world, 'findByKey');
  const session = world.sessions.find(item => item.key === key);

  if (session === undefined) return { outcome: 'absent' };

  const found: FindResult = {
    outcome: 'found',
    platformSessionRef: session.ref,
    address: session.address,
  };

  return found;
}

function started(session: SimSession, input: StartSessionInput): StartSessionResult {
  return {
    platformSessionRef: session.ref,
    address: session.address,
    attributedTo: input.onBehalfOf === null ? 'service' : 'owner',
    secretDelivered: input.secret === null ? 'no' : 'yes',
  };
}

function mapped(raw: string, logs: string[]): NeutralStatus {
  if (isNeutralStatus(raw)) return raw;

  logs.push(`Unrecognized platform status ${raw} mapped to working.`);

  return 'working';
}

export function descriptionFor(world: SimWorld): AdapterDescription {
  return {
    name: 'simulated',
    usageUnit: world.usageUnit,
    usageUnitDisplay: world.usageUnitDisplay,
    modelTiers: [],
    platformSettingKeys: [],
    roleCeilings: { ...world.roleCeilings },
    repositoriesRequired: false,
  };
}
