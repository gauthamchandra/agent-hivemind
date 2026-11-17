import type { ConnectionId } from '@/domain/ids.ts';
import type { NeutralStatus } from '@/domain/model.ts';
import { isNeutralStatus } from '@/domain/model.ts';
import {
  type Capability,
  capabilities,
  PlatformError,
  type PlatformErrorClass,
  type SendResult,
} from '@/domain/platform.ts';
import type { ConformanceControls } from '@/ports/conformance.ts';
import type {
  AdapterDescription,
  FindResult,
  PlatformAdapter,
  PlatformConnection,
  StartSessionInput,
  StartSessionResult,
} from '@/ports/platform.ts';

type SimSession = {
  key: string;
  ref: string;
  address: string;
  prompt: string;
  secret: string | null;
  rawStatus: string;
  usageFloor: number;
  ended: boolean;
};

export type SimulatedPlatform = {
  adapter: PlatformAdapter;
  controls: ConformanceControls;
  connection(): PlatformConnection;
  drop(capability: Capability): void;
  queueError(operation: string, errorClass: PlatformErrorClass): void;
  loseNextStartResponse(): void;
  prompts(): string[];
  secretFor(idempotencyKey: string): string | null;
  calls(): readonly string[];
};

const messages: Record<PlatformErrorClass, string> = {
  auth: 'The platform refused the credential.',
  rate_limited: 'The platform asked the caller to slow.',
  quota: 'The platform account reached a limit.',
  invalid: 'The platform rejected the request.',
  not_found: 'The platform does not know that session.',
  unavailable: 'The platform did not answer.',
};

/** An in-memory platform. Tests script its status, usage, and failures. */
export function createSimulatedPlatform(connectionId: ConnectionId): SimulatedPlatform {
  const enabled = new Set<Capability>(capabilities);
  const sessions: SimSession[] = [];
  const logs: string[] = [];
  const calls: string[] = [];
  let queued: { operation: string; errorClass: PlatformErrorClass } | null = null;
  let loseStart = false;
  let sendResult: SendResult = 'accepted';
  let reportedUsage = 0;
  const credential = 'simulated-credential';

  const failIfQueued = (operation: string): void => {
    if (queued?.operation !== operation) return;

    const errorClass = queued.errorClass;

    queued = null;

    throw new PlatformError(errorClass, messages[errorClass]);
  };

  const requireSession = (ref: string): SimSession => {
    const session = sessions.find(item => item.ref === ref);

    if (session === undefined) throw new PlatformError('not_found', messages.not_found);

    return session;
  };

  const adapter: PlatformAdapter = {
    async probe() {
      calls.push('probe');
      failIfQueued('probe');

      return { capabilities: [...enabled] };
    },

    async start(_connection, input) {
      calls.push('start');
      failIfQueued('start');

      const existing = sessions.find(item => item.key === input.idempotencyKey);

      if (existing !== undefined && enabled.has('idempotent_start'))
        return started(existing, input);

      const session: SimSession = {
        key: input.idempotencyKey,
        ref: `plat_${input.idempotencyKey}`,
        address: `https://platform.example/sessions/${input.idempotencyKey}`,
        prompt: input.prompt,
        secret: input.secret?.value ?? null,
        rawStatus: 'working',
        usageFloor: 0,
        ended: false,
      };

      sessions.push(session);

      if (loseStart) {
        loseStart = false;

        throw new PlatformError('unavailable', messages.unavailable);
      }

      return started(session, input);
    },

    async readStatus(_connection, ref) {
      calls.push('readStatus');
      failIfQueued('readStatus');

      return { status: mapped(requireSession(ref).rawStatus, logs) };
    },

    async readMany(_connection, refs) {
      calls.push('readMany');
      failIfQueued('readMany');

      return refs.map(ref => ({
        platformSessionRef: ref,
        status: mapped(requireSession(ref).rawStatus, logs),
      }));
    },

    async send(_connection, ref, body) {
      const session = requireSession(ref);

      if (session.ended) {
        calls.push('send_suppressed');

        return 'gone';
      }

      calls.push('send');
      failIfQueued('send');

      if (Buffer.byteLength(body) > 16 * 1024) {
        throw new PlatformError('invalid', messages.invalid);
      }

      return sendResult;
    },

    async suspend(_connection, ref) {
      calls.push('suspend');
      failIfQueued('suspend');
      requireSession(ref).rawStatus = 'suspended';
    },

    async end(_connection, ref) {
      calls.push('end');
      failIfQueued('end');
      const session = sessions.find(item => item.ref === ref);

      if (session !== undefined) {
        session.ended = true;
        session.rawStatus = 'stopped';
      }
    },

    async readUsage(_connection, ref) {
      calls.push('readUsage');
      failIfQueued('readUsage');
      const session = requireSession(ref);

      if (reportedUsage < session.usageFloor) {
        logs.push('A usage reading went backwards. The earlier reading was kept.');

        return session.usageFloor;
      }

      session.usageFloor = reportedUsage;

      return session.usageFloor;
    },

    describe() {
      return description();
    },

    async findByKey(_connection, key) {
      calls.push('findByKey');
      failIfQueued('findByKey');
      const session = sessions.find(item => item.key === key);

      if (session === undefined) return { outcome: 'absent' };

      const found: FindResult = {
        outcome: 'found',
        platformSessionRef: session.ref,
        address: session.address,
      };

      return found;
    },
  };

  const controls: ConformanceControls = {
    documentedCapabilities: capabilities,
    documentedStatuses: [
      { platform: 'working', neutral: 'working' },
      { platform: 'idle', neutral: 'idle' },
      { platform: 'waiting_for_person', neutral: 'waiting_for_person' },
      { platform: 'suspended', neutral: 'suspended' },
      { platform: 'stopped', neutral: 'stopped' },
      { platform: 'failed', neutral: 'failed' },
      { platform: 'unknown', neutral: 'unknown' },
    ],
    unrecognizedStatus: 'not-a-status',
    credential,
    promptMarker: 'PROMPT-MARKER-VALUE',
    messageMarker: 'MESSAGE-MARKER-VALUE',
    setPlatformStatus(status) {
      const latest = sessions.at(-1);

      if (latest !== undefined) latest.rawStatus = status;
    },
    queueError(operation, errorClass) {
      queued = { operation, errorClass };
    },
    setSendResult(result) {
      sendResult = result;
    },
    setReportedUsage(value) {
      reportedUsage = value;
    },
    logs: () => logs,
    calls: () => calls,
    loseNextStartResponse() {
      loseStart = true;
    },
  };

  return {
    adapter,
    controls,
    connection: () => ({
      id: connectionId,
      capabilities: [...enabled],
      secret: credential,
      settings: {},
      usageUnit: 'unit',
      usageUnitDisplay: 'Units',
    }),
    drop(capability) {
      enabled.delete(capability);
    },
    queueError: controls.queueError,
    loseNextStartResponse: controls.loseNextStartResponse,
    prompts: () => sessions.map(session => session.prompt),
    secretFor(key) {
      return sessions.find(session => session.key === key)?.secret ?? null;
    },
    calls: () => calls,
  };
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

function description(): AdapterDescription {
  return {
    name: 'simulated',
    usageUnit: 'unit',
    usageUnitDisplay: 'Units',
    modelTiers: [],
    platformSettingKeys: [],
    roleCeilings: { planner: 20, challenger: 10, implementer: 30, reviewer: 10, verifier: 10 },
    repositoriesRequired: false,
  };
}
