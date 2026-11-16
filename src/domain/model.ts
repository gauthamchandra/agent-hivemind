import type {
  ConnectionId,
  EventId,
  GroupId,
  OperatorKeyId,
  PersonId,
  SessionId,
  TaskId,
  WorkspaceId,
} from '@/domain/ids.ts';

export const sessionRoles = [
  'planner',
  'challenger',
  'implementer',
  'reviewer',
  'verifier',
] as const;
export type SessionRole = (typeof sessionRoles)[number];

export const taskStates = [
  'planned',
  'analyzing',
  'implementing',
  'in_review',
  'approved',
  'verifying_before_merge',
  'merging',
  'verifying_after_merge',
  'done',
  'failed',
] as const;
export type TaskState = (typeof taskStates)[number];

export const verificationModes = ['before_merge', 'both', 'after_merge'] as const;
export type VerificationMode = (typeof verificationModes)[number];

export const operatorKeyRoles = ['reader', 'creator', 'administrator', 'bootstrap'] as const;
export type OperatorKeyRole = (typeof operatorKeyRoles)[number];

export const workspaceRoles = ['member', 'administrator'] as const;
export type WorkspaceRole = (typeof workspaceRoles)[number];

export function isSessionRole(value: string): value is SessionRole {
  return sessionRoles.some(role => role === value);
}

export function isTaskState(value: string): value is TaskState {
  return taskStates.some(state => state === value);
}

export function isVerificationMode(value: string): value is VerificationMode {
  return verificationModes.some(mode => mode === value);
}

export function isOperatorKeyRole(value: string): value is OperatorKeyRole {
  return operatorKeyRoles.some(role => role === value);
}

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return workspaceRoles.some(role => role === value);
}

export function isClosedState(state: TaskState): boolean {
  return state === 'done' || state === 'failed';
}

export type EvidenceEntry = {
  label: string;
  kind: 'address' | 'text';
  value: string;
};

export type GroupCaps = {
  live_sessions: number;
  live_per_role: { planner: number; challenger: number; implementer: number };
  live_per_task_role: { reviewer: number; verifier: number };
  spawn_rate: number;
  respawns_per_task_role: number;
  total_sessions: number;
};

/** Defaults copied onto a group at creation. They are the self-hosted figures from the plan. */
export const selfHostedGroupCaps: GroupCaps = {
  live_sessions: 10,
  live_per_role: { planner: 1, challenger: 2, implementer: 4 },
  live_per_task_role: { reviewer: 1, verifier: 1 },
  spawn_rate: 6,
  respawns_per_task_role: 3,
  total_sessions: 50,
};

export type WorkspaceLimits = {
  live_groups: number;
  live_sessions: number;
  groups_per_day: number;
  members_read_all: boolean;
  default_group_caps: GroupCaps;
};

export const selfHostedLimits: WorkspaceLimits = {
  live_groups: 20,
  live_sessions: 50,
  groups_per_day: 50,
  members_read_all: true,
  default_group_caps: selfHostedGroupCaps,
};

export type SessionSettings = {
  model_tier: string | null;
  repositories: string[];
  platform_settings: Readonly<Record<string, string | number | boolean | null>>;
  role_tiers: Partial<Record<SessionRole, string>>;
};

export const emptySessionSettings: SessionSettings = {
  model_tier: null,
  repositories: [],
  platform_settings: {},
  role_tiers: {},
};

export type Workspace = {
  id: WorkspaceId;
  name: string;
  status: 'active' | 'suspended';
  limits: WorkspaceLimits;
  created_at: string;
};

export type Person = {
  id: PersonId;
  workspace_id: WorkspaceId;
  display_name: string;
  workspace_role: WorkspaceRole;
  account_id: null;
  status: 'active' | 'disabled';
  created_at: string;
};

export type OperatorKeyRecord = {
  id: OperatorKeyId;
  workspace_id: WorkspaceId;
  name: string;
  role: OperatorKeyRole;
  key_hash: string;
  person_id: PersonId | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
};

export type ContextNote = {
  workspace_id: WorkspaceId;
  group_id: GroupId;
  position: number;
  name: string;
  body: string;
};

export type Group = {
  id: GroupId;
  workspace_id: WorkspaceId;
  name: string;
  goal: string;
  owner_person_id: PersonId;
  default_verification_mode: VerificationMode;
  connection_id: ConnectionId;
  budget: string;
  spend: string;
  caps: GroupCaps;
  session_settings: SessionSettings;
  context_fingerprint: string;
  features: string[];
  initiator: string | null;
  status: 'open' | 'closed';
  created_at: string;
  closed_at: string | null;
};

export type Task = {
  id: TaskId;
  workspace_id: WorkspaceId;
  group_id: GroupId;
  parent_id: TaskId | null;
  title: string;
  description: string;
  state: TaskState;
  state_entered_at: string;
  verification_mode: VerificationMode;
  changeset_id: null;
  depends_on: TaskId[];
  changeset_round: number;
  respawns_used: number;
  created_by_kind: 'session' | 'person' | 'service';
  created_by_id: string;
  created_at: string;
  closed_at: string | null;
  version: number;
};

export type TaskEvent = {
  id: EventId;
  workspace_id: WorkspaceId;
  task_id: TaskId;
  group_id: GroupId;
  sequence: number;
  kind: 'created' | 'transition' | 'verification_mode_changed' | 'owner_instruction';
  actor_kind: 'session' | 'person' | 'service';
  actor_id: string;
  from_state: TaskState | null;
  to_state: TaskState | null;
  evidence: EvidenceEntry[];
  note: string | null;
  data: Readonly<Record<string, string | number | boolean | null>>;
  at: string;
};

export type ActorRef = {
  kind: 'session' | 'person' | 'service';
  id: SessionId | PersonId | 'hivemind-svc';
};
