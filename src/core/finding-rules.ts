import { considerSession, cycleGroups } from '@/core/finding-session-rules.ts';
import { held, push } from '@/core/finding-text.ts';
import { compareDecimal } from '@/domain/decimal.ts';
import type { GroupId, WorkspaceId } from '@/domain/ids.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { Group, SessionRecord, SessionRole, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import type { Capability } from '@/domain/platform.ts';
import type {
  ConnectionWatch,
  FindingRecord,
  FindingRule,
  FindingSeverity,
  SessionWatch,
} from '@/domain/supervision.ts';
import {
  authFailures,
  deliveryBacklogMs,
  roleExpectedToAct,
  spendUnknownMs,
  taskStalledMs,
  taskWithoutSessionMs,
  waitOverdueMs,
} from '@/domain/supervision.ts';

export type DesiredFinding = {
  rule: FindingRule;
  targetId: string;
  workspaceId: WorkspaceId;
  groupId: GroupId | null;
  severity: FindingSeverity;
  reason: string | null;
};

export type Evaluation = {
  nowMs: number;
  groups: readonly Group[];
  tasks: readonly Task[];
  sessions: readonly SessionRecord[];
  waits: readonly WaitRecord[];
  watches: ReadonlyMap<string, SessionWatch>;
  ceilings: ReadonlyMap<string, Partial<Record<SessionRole, number>>>;
  capabilities: ReadonlyMap<string, readonly Capability[]>;
  queuedAt: ReadonlyMap<string, number>;
  activityAt: ReadonlyMap<string, number>;
  relayed: ReadonlySet<string>;
  expiredCodes: ReadonlySet<string>;
  connectionWatches: ReadonlyMap<string, ConnectionWatch>;
  findings: readonly FindingRecord[];
};

export type Indexes = {
  groups: Map<string, Group>;
  tasks: Map<string, Task>;
  sessions: Map<string, SessionRecord>;
  children: Map<string, Task[]>;
};

export function desiredFindings(input: Evaluation): DesiredFinding[] {
  const indexes = indexOf(input);
  const desired: DesiredFinding[] = [];

  for (const session of input.sessions) considerSession(input, indexes, session, desired);
  for (const wait of input.waits) considerWait(input, indexes, wait, desired);
  for (const groupId of cycleGroups(input.waits, indexes.sessions)) {
    const group = indexes.groups.get(groupId);

    if (group) push(desired, 'wait_cycle', group.id, group.workspace_id, group.id, null);
  }

  for (const task of input.tasks) considerTask(input, task, desired);
  for (const group of input.groups) considerGroup(input, indexes, group, desired);
  considerConnections(input, desired);

  return desired;
}

function considerWait(
  input: Evaluation,
  indexes: Indexes,
  wait: WaitRecord,
  desired: DesiredFinding[]
): void {
  const session = indexes.sessions.get(wait.waiting_session_id);
  const task = session === undefined ? undefined : indexes.tasks.get(session.task_id);
  const deadline = Date.parse(wait.deadline_at);

  if (session === undefined || task === undefined || session.life === 'ended') return;
  if (isClosedState(task.state) || input.nowMs < deadline) return;

  const progressed =
    session.last_report_at !== null && Date.parse(session.last_report_at) > deadline;

  if (progressed) return;

  push(desired, 'wait_expired', wait.id, wait.workspace_id, wait.group_id, null);

  if (input.nowMs - deadline >= waitOverdueMs) {
    push(desired, 'wait_overdue', wait.id, wait.workspace_id, wait.group_id, null);
  }
}

function considerTask(input: Evaluation, task: Task, desired: DesiredFinding[]): void {
  if (isClosedState(task.state)) return;

  const activity = input.activityAt.get(task.id) ?? Date.parse(task.created_at);

  if (input.nowMs - activity >= taskStalledMs) {
    push(desired, 'task_stalled', task.id, task.workspace_id, task.group_id, null);
  }

  const role = roleExpectedToAct(task);
  const holder =
    role !== null &&
    input.sessions.some(
      session =>
        session.task_id === task.id &&
        session.role === role &&
        (session.life === 'live' || session.life === 'released')
    );

  if (role !== null && !holder && held(input.nowMs, task.state_entered_at, taskWithoutSessionMs)) {
    push(desired, 'task_without_session', task.id, task.workspace_id, task.group_id, null);
  }
}

function considerGroup(
  input: Evaluation,
  indexes: Indexes,
  group: Group,
  desired: DesiredFinding[]
): void {
  if (group.status !== 'open') return;

  if (atLeast(group.spend, group.budget, 4, 5)) {
    push(desired, 'budget_80', group.id, group.workspace_id, group.id, null);
  }

  if (compareDecimal(group.spend, group.budget) >= 0) {
    push(desired, 'budget_reached', group.id, group.workspace_id, group.id, null);
  }

  const root = input.tasks.find(task => task.group_id === group.id && task.parent_id === null);
  const children = indexes.children.get(group.id) ?? [];

  if (
    root !== undefined &&
    !isClosedState(root.state) &&
    children.length > 0 &&
    children.every(task => isClosedState(task.state)) &&
    children.some(task => task.state === 'failed')
  ) {
    push(desired, 'root_needs_decision', group.id, group.workspace_id, group.id, null);
  }

  const capable = input.capabilities.get(group.connection_id)?.includes('usage_reading') ?? true;
  const readings = input.sessions
    .filter(session => session.group_id === group.id)
    .map(session => input.watches.get(session.id)?.lastReadingAt ?? null);
  const newest = readings.reduce<number | null>((latest, at) => {
    if (at === null) return latest;

    const ms = Date.parse(at);

    return latest === null || ms > latest ? ms : latest;
  }, null);
  const stale =
    readings.length > 0 &&
    (newest === null
      ? held(input.nowMs, group.created_at, spendUnknownMs)
      : input.nowMs - newest >= spendUnknownMs);

  if (!capable || stale) {
    push(desired, 'spend_unknown', group.id, group.workspace_id, group.id, null);
  }
}

function considerConnections(input: Evaluation, desired: DesiredFinding[]): void {
  for (const [connectionId, watch] of input.connectionWatches) {
    if (watch.probeFailed || watch.authFailStreak >= authFailures) {
      push(desired, 'connection_failing', connectionId, watch.workspaceId, null, null);
    }

    const queued = input.queuedAt.get(connectionId);

    if (queued !== undefined && input.nowMs - queued >= deliveryBacklogMs) {
      push(desired, 'delivery_backlog', connectionId, watch.workspaceId, null, null);
    }
  }

  for (const [connectionId, queued] of input.queuedAt) {
    if (input.connectionWatches.has(connectionId)) continue;
    if (input.nowMs - queued < deliveryBacklogMs) continue;

    const group = input.groups.find(item => item.connection_id === connectionId);

    if (group) {
      push(desired, 'delivery_backlog', connectionId, group.workspace_id, null, null);
    }
  }
}

function indexOf(input: Evaluation): Indexes {
  const groups = new Map(input.groups.map(group => [group.id, group]));
  const tasks = new Map(input.tasks.map(task => [task.id, task]));
  const sessions = new Map(input.sessions.map(session => [session.id, session]));
  const children = new Map<string, Task[]>();

  for (const task of input.tasks) {
    if (task.parent_id === null) continue;

    const list = children.get(task.group_id) ?? [];

    list.push(task);
    children.set(task.group_id, list);
  }

  return { groups, tasks, sessions, children };
}

function atLeast(spend: string, budget: string, numerator: number, denominator: number): boolean {
  const width = Math.max(scaleOf(spend), scaleOf(budget));

  return scaled(spend, width) * BigInt(denominator) >= scaled(budget, width) * BigInt(numerator);
}

function scaleOf(value: string): number {
  return value.split('.')[1]?.length ?? 0;
}

function scaled(value: string, width: number): bigint {
  const [whole, fraction = ''] = value.split('.');

  return BigInt(`${whole}${fraction.padEnd(width, '0')}`);
}
