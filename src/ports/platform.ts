import type { ConnectionId } from '@/domain/ids.ts';
import type { NeutralStatus, SessionRole, SessionSettings } from '@/domain/model.ts';
import type { Capability, SendResult } from '@/domain/platform.ts';

export type PlatformConnection = {
  id: ConnectionId;
  capabilities: readonly Capability[];
  secret: string;
  settings: Readonly<Record<string, string | number | boolean | null>>;
  usageUnit: string;
  usageUnitDisplay: string;
};

export type StartSessionInput = {
  prompt: string;
  title: string;
  idempotencyKey: string;
  settings: SessionSettings;
  secret: { name: string; value: string } | null;
  onBehalfOf: string | null;
  usageCeiling: number | null;
  tags: { workspaceId: string; groupId: string; sessionId: string; role: string };
};

export type StartSessionResult = {
  platformSessionRef: string;
  address: string | null;
  attributedTo: 'owner' | 'service';
  secretDelivered: 'yes' | 'no' | 'unknown';
};

export type FindResult =
  | { outcome: 'found'; platformSessionRef: string; address: string | null }
  | { outcome: 'absent' }
  | { outcome: 'inconclusive' };

export type AdapterDescription = {
  name: string;
  usageUnit: string;
  usageUnitDisplay: string;
  modelTiers: readonly string[];
  platformSettingKeys: readonly string[];
  roleCeilings: Partial<Record<SessionRole, number>>;
  repositoriesRequired: boolean;
};

export interface PlatformAdapter {
  probe(connection: PlatformConnection): Promise<{ capabilities: readonly Capability[] }>;
  start(connection: PlatformConnection, input: StartSessionInput): Promise<StartSessionResult>;
  readStatus(
    connection: PlatformConnection,
    platformSessionRef: string
  ): Promise<{ status: NeutralStatus }>;
  readMany(
    connection: PlatformConnection,
    platformSessionRefs: readonly string[]
  ): Promise<{ platformSessionRef: string; status: NeutralStatus }[]>;
  send(
    connection: PlatformConnection,
    platformSessionRef: string,
    body: string
  ): Promise<SendResult>;
  suspend(connection: PlatformConnection, platformSessionRef: string): Promise<void>;
  end(connection: PlatformConnection, platformSessionRef: string): Promise<void>;
  readUsage(connection: PlatformConnection, platformSessionRef: string): Promise<number>;
  describe(): AdapterDescription;
  findByKey(
    connection: PlatformConnection,
    idempotencyKey: string,
    startedAt: string
  ): Promise<FindResult>;
}

export type Platforms = {
  require(id: ConnectionId): { adapter: PlatformAdapter; connection: PlatformConnection };
};
