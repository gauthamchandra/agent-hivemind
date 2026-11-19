import type { ConnectionId } from '@/domain/ids.ts';
import type { SessionRole } from '@/domain/model.ts';
import { type Capability, capabilities } from '@/domain/platform.ts';
import {
  descriptionFor,
  end,
  findByKey,
  probe,
  readMany,
  readStatus,
  readUsage,
  type SimWorld,
  send,
  start,
  suspend,
} from '@/platform/simulated/simulated-world.ts';
import type { ConformanceControls } from '@/ports/conformance.ts';
import type { PlatformAdapter, PlatformConnection } from '@/ports/platform.ts';

export type SimulatedPlatform = {
  adapter: PlatformAdapter;
  controls: ConformanceControls;
  connection(): PlatformConnection;
  drop(capability: Capability): void;
  queueError(
    operation: string,
    errorClass: import('@/domain/platform.ts').PlatformErrorClass
  ): void;
  loseNextStartResponse(): void;
  prompts(): string[];
  secretFor(idempotencyKey: string): string | null;
  calls(): readonly string[];
  sentMessages(): {
    ref: string;
    body: string;
    statusAtSend: string;
    result: import('@/domain/platform.ts').SendResult;
  }[];
  setSessionStatus(ref: string, status: string): void;
  setSessionUsage(ref: string, usage: number): void;
  setRoleCeiling(role: SessionRole, ceiling: number): void;
  setUsageUnit(unit: string, display: string): void;
  plantSession(key: string): void;
};

export function createSimulatedPlatform(
  connectionId: ConnectionId,
  options?: { recordSent?: boolean; usageUnit?: string; usageUnitDisplay?: string }
): SimulatedPlatform {
  const world: SimWorld = {
    enabled: new Set(capabilities),
    sessions: [],
    logs: [],
    calls: [],
    sent: [],
    recordSent: options?.recordSent !== false,
    queued: null,
    loseStart: false,
    sendResult: 'accepted',
    reportedUsage: 0,
    usageUnit: options?.usageUnit ?? 'unit',
    usageUnitDisplay: options?.usageUnitDisplay ?? 'Units',
    roleCeilings: { planner: 20, challenger: 10, implementer: 30, reviewer: 10, verifier: 10 },
    credential: 'simulated-credential',
  };
  const adapter: PlatformAdapter = {
    probe: () => probe(world),
    start: (_connection, input) => start(world, input),
    readStatus: (_connection, ref) => readStatus(world, ref),
    readMany: (_connection, refs) => readMany(world, refs),
    send: (_connection, ref, body) => send(world, ref, body),
    suspend: (_connection, ref) => suspend(world, ref),
    end: (_connection, ref) => end(world, ref),
    readUsage: (_connection, ref) => readUsage(world, ref),
    describe: () => descriptionFor(world),
    findByKey: (_connection, key) => findByKey(world, key),
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
    credential: world.credential,
    promptMarker: 'PROMPT-MARKER-VALUE',
    messageMarker: 'MESSAGE-MARKER-VALUE',
    setPlatformStatus(status) {
      const latest = world.sessions.at(-1);

      if (latest !== undefined) latest.rawStatus = status;
    },
    queueError(operation, errorClass) {
      world.queued = { operation, errorClass };
    },
    setSendResult(result) {
      world.sendResult = result;
    },
    setReportedUsage(value) {
      world.reportedUsage = value;
    },
    logs: () => world.logs,
    calls: () => world.calls,
    loseNextStartResponse() {
      world.loseStart = true;
    },
  };

  return {
    adapter,
    controls,
    connection: () => ({
      id: connectionId,
      capabilities: [...world.enabled],
      secret: world.credential,
      settings: {},
      usageUnit: world.usageUnit,
      usageUnitDisplay: world.usageUnitDisplay,
    }),
    drop(capability) {
      world.enabled.delete(capability);
    },
    queueError: controls.queueError,
    loseNextStartResponse: controls.loseNextStartResponse,
    prompts: () => world.sessions.map(session => session.prompt),
    secretFor(key) {
      return world.sessions.find(session => session.key === key)?.secret ?? null;
    },
    calls: () => world.calls,
    sentMessages: () => world.sent,
    setSessionStatus(ref, status) {
      const session = world.sessions.find(item => item.ref === ref);

      if (session !== undefined) session.rawStatus = status;
    },
    setSessionUsage(ref, usage) {
      const session = world.sessions.find(item => item.ref === ref);

      if (session !== undefined) session.reported = usage;
    },
    setRoleCeiling(role, ceiling) {
      world.roleCeilings[role] = ceiling;
    },
    setUsageUnit(unit, display) {
      world.usageUnit = unit;
      world.usageUnitDisplay = display;
    },
    plantSession(key) {
      world.sessions.push({
        key,
        ref: `plat_${key}`,
        address: `https://platform.example/sessions/${key}`,
        prompt: '',
        secret: null,
        rawStatus: 'working',
        usageFloor: 0,
        reported: null,
        ended: false,
      });
    },
  };
}
