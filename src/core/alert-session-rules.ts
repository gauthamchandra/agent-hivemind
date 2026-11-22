import type { DesiredAlert, Evaluation, Indexes } from '@/core/alert-rules.ts';
import { held, push } from '@/core/alert-severity.ts';
import type { AlertRule, SessionJobState } from '@/domain/background-jobs.ts';
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
} from '@/domain/background-jobs.ts';
import { compareDecimal, decimalFromNumber } from '@/domain/decimal.ts';
import type { SessionLife, SessionRecord, Task } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';

const livesBeforeAnEndSettles: ReadonlySet<SessionLife> = new Set(['starting', 'live', 'released']);

export function considerSession(
  input: Evaluation,
  indexes: Indexes,
  session: SessionRecord,
  desired: DesiredAlert[]
): void {
  const task = indexes.tasks.get(session.task_id);
  const group = indexes.groups.get(session.group_id);
  const jobState = input.jobStates.get(session.id);

  if (task === undefined || group === undefined) return;

  const open = !isClosedState(task.state);
  const active = session.life === 'live' || session.life === 'released';
  const flag = (rule: AlertRule): void =>
    push(desired, rule, session.id, session.workspace_id, session.group_id, null);

  if (active && open && (jobState?.badStatusStreak ?? 0) >= deadReadings) {
    flag('session_dead');
  }

  if (
    active &&
    open &&
    session.last_status === 'waiting_for_person' &&
    held(input.nowMs, jobState?.statusSince ?? null, waitingForPersonMs)
  ) {
    flag('session_waiting_for_person');
  }

  if (
    session.life === 'live' &&
    open &&
    session.enrolled_at === null &&
    notEnrolled(input, session)
  ) {
    flag('session_not_enrolled');
  }

  if (idle(input, session, task, active, open)) {
    flag('session_idle_on_open_task');
  }

  const ceiling = input.ceilings.get(group.connection_id)?.[session.role];

  if (active && session.usage !== null && ceiling !== undefined && above(session.usage, ceiling)) {
    flag('session_over_role_ceiling');
  }

  if (
    session.life === 'ended' &&
    session.last_status !== null &&
    session.last_status !== 'stopped' &&
    session.last_status !== 'failed' &&
    (jobState?.endUnconfirmedRuns ?? 0) >= endNotConfirmedRuns
  ) {
    flag('end_not_confirmed');
  }

  if (
    session.end_requested_at !== null &&
    livesBeforeAnEndSettles.has(session.life) &&
    (jobState?.endAttemptRuns ?? 0) >= endPendingRuns
  ) {
    flag('end_pending');
  }

  if (session.life === 'starting' && unresolved(input, session, jobState)) {
    flag('start_unresolved');
  }

  if (input.relayed.has(session.id) && active) {
    flag('instruction_relayed');
  }

  keepEscalation(input, session, desired);
}

// The route opens an escalation and the poll only keeps it, so it is kept for as long as the
// session has not ended.
function keepEscalation(input: Evaluation, session: SessionRecord, desired: DesiredAlert[]): void {
  if (session.life === 'ended') return;

  const escalation = input.alerts.find(
    alert => alert.rule === 'escalation' && alert.targetId === session.id
  );

  if (escalation !== undefined) {
    push(
      desired,
      'escalation',
      session.id,
      session.workspace_id,
      session.group_id,
      escalation.reason
    );
  }
}

function idle(
  input: Evaluation,
  session: SessionRecord,
  task: Task,
  active: boolean,
  open: boolean
): boolean {
  const jobState = input.jobStates.get(session.id);
  const waiting = input.waits.some(wait => wait.waiting_session_id === session.id);

  return (
    active &&
    open &&
    !waiting &&
    (session.last_status === 'idle' || session.last_status === 'suspended') &&
    session.role === roleExpectedToAct(task) &&
    held(input.nowMs, jobState?.statusSince ?? null, idleOnTaskMs)
  );
}

function unresolved(
  input: Evaluation,
  session: SessionRecord,
  jobState: SessionJobState | undefined
): boolean {
  const runs = jobState?.inconclusiveRuns ?? 0;
  const absent = jobState?.lastFind === 'absent';
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
  if (!Number.isFinite(ceiling) || ceiling < 0) return false;

  return compareDecimal(usage, decimalFromNumber(ceiling)) > 0;
}
