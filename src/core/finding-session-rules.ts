import type { DesiredFinding, Evaluation, Indexes } from '@/core/finding-rules.ts';
import { held, push } from '@/core/finding-text.ts';
import { compareDecimal, decimalFromNumber } from '@/domain/decimal.ts';
import type { WaitRecord } from '@/domain/message.ts';
import type { SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import type { SessionWatch } from '@/domain/supervision.ts';
import {
  deadReadings,
  endNotConfirmedRuns,
  endPendingRuns,
  idleOnTaskMs,
  notEnrolledMs,
  roleExpectedToAct,
  searchWindowMs,
  startUnresolvedRuns,
  waitingForPersonMs,
} from '@/domain/supervision.ts';

export function considerSession(
  input: Evaluation,
  indexes: Indexes,
  session: SessionRecord,
  desired: DesiredFinding[]
): void {
  const task = indexes.tasks.get(session.task_id);
  const group = indexes.groups.get(session.group_id);
  const watch = input.watches.get(session.id);

  if (task === undefined || group === undefined) return;

  const open = !isClosedState(task.state);
  const active = session.life === 'live' || session.life === 'released';

  if (active && open && (watch?.badStatusStreak ?? 0) >= deadReadings) {
    push(desired, 'session_dead', session.id, session.workspace_id, session.group_id, null);
  }

  if (
    active &&
    session.last_status === 'waiting_for_person' &&
    held(input.nowMs, watch?.statusSince ?? null, waitingForPersonMs)
  ) {
    push(
      desired,
      'session_waiting_for_person',
      session.id,
      session.workspace_id,
      session.group_id,
      null
    );
  }

  if (session.life === 'live' && session.enrolled_at === null && notEnrolled(input, session)) {
    push(desired, 'session_not_enrolled', session.id, session.workspace_id, session.group_id, null);
  }

  if (idle(input, session, task, active, open)) {
    push(
      desired,
      'session_idle_on_open_task',
      session.id,
      session.workspace_id,
      session.group_id,
      null
    );
  }

  const ceiling = input.ceilings.get(group.connection_id)?.[session.role];

  if (session.usage !== null && ceiling !== undefined && above(session.usage, ceiling)) {
    push(
      desired,
      'session_over_role_ceiling',
      session.id,
      session.workspace_id,
      session.group_id,
      null
    );
  }

  if (
    session.life === 'ended' &&
    session.last_status !== null &&
    session.last_status !== 'stopped' &&
    session.last_status !== 'failed' &&
    (watch?.endUnconfirmedRuns ?? 0) >= endNotConfirmedRuns
  ) {
    push(desired, 'end_not_confirmed', session.id, session.workspace_id, session.group_id, null);
  }

  if (
    session.end_requested_at !== null &&
    (session.life === 'starting' || session.life === 'live') &&
    (watch?.endAttemptRuns ?? 0) >= endPendingRuns
  ) {
    push(desired, 'end_pending', session.id, session.workspace_id, session.group_id, null);
  }

  if (session.life === 'starting' && unresolved(input, session, watch)) {
    push(desired, 'start_unresolved', session.id, session.workspace_id, session.group_id, null);
  }

  if (watch?.orphanEnded && group.status === 'open') {
    push(
      desired,
      'orphan_platform_session_ended',
      session.id,
      session.workspace_id,
      session.group_id,
      null
    );
  }

  if (input.relayed.has(session.id) && active) {
    push(desired, 'instruction_relayed', session.id, session.workspace_id, session.group_id, null);
  }

  keepEscalation(input, session, desired);
}

function keepEscalation(
  input: Evaluation,
  session: SessionRecord,
  desired: DesiredFinding[]
): void {
  const escalation = input.findings.find(
    finding =>
      finding.rule === 'escalation' &&
      finding.targetId === session.id &&
      finding.clearedAt === null &&
      session.life !== 'ended' &&
      session.life !== 'start_failed'
  );

  if (escalation === undefined) return;

  desired.push({
    rule: 'escalation',
    targetId: session.id,
    workspaceId: session.workspace_id,
    groupId: session.group_id,
    severity: 'critical',
    reason: escalation.reason,
  });
}

function idle(
  input: Evaluation,
  session: SessionRecord,
  task: Task,
  active: boolean,
  open: boolean
): boolean {
  const watch = input.watches.get(session.id);
  const waiting = input.waits.some(wait => wait.waiting_session_id === session.id);

  return (
    active &&
    open &&
    !waiting &&
    (session.last_status === 'idle' || session.last_status === 'suspended') &&
    session.role === roleExpectedToAct(task) &&
    held(input.nowMs, watch?.statusSince ?? null, idleOnTaskMs)
  );
}

function unresolved(
  input: Evaluation,
  session: SessionRecord,
  watch: SessionWatch | undefined
): boolean {
  const runs = watch?.inconclusiveRuns ?? 0;
  const absent = watch?.lastFind === 'absent';
  const aged = held(input.nowMs, session.created_at, searchWindowMs);

  return (
    runs >= startUnresolvedRuns ||
    (absent && session.existence_evidence_at !== null) ||
    (absent && aged)
  );
}

function notEnrolled(input: Evaluation, session: SessionRecord): boolean {
  return held(input.nowMs, session.created_at, notEnrolledMs) || input.expiredCodes.has(session.id);
}

function above(usage: string, ceiling: number): boolean {
  return compareDecimal(usage, decimalFromNumber(ceiling)) > 0;
}

export function cycleGroups(
  waits: readonly WaitRecord[],
  sessions: Map<string, SessionRecord>
): string[] {
  const next = new Map<string, string[]>();

  for (const wait of waits) {
    const list = next.get(wait.waiting_session_id) ?? [];

    list.push(wait.awaited_session_id);
    next.set(wait.waiting_session_id, list);
  }

  const color = new Map<string, number>();
  const groups = new Set<string>();

  const visit = (id: string, stack: string[]): void => {
    color.set(id, 1);
    stack.push(id);

    for (const step of next.get(id) ?? []) {
      const seen = color.get(step) ?? 0;

      if (seen === 1) {
        const cycle = stack.slice(stack.indexOf(step));

        if (cycle.length >= 2) {
          for (const member of cycle) {
            const session = sessions.get(member);

            if (session) groups.add(session.group_id);
          }
        }
      } else if (seen === 0) visit(step, stack);
    }

    stack.pop();
    color.set(id, 2);
  };

  for (const id of next.keys()) {
    if ((color.get(id) ?? 0) === 0) visit(id, []);
  }

  return [...groups];
}
