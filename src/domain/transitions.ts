import type { ErrorDetails } from '@/domain/errors.ts';
import type { EvidenceEntry, SessionRole, TaskState, VerificationMode } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';

export type TransitionActor =
  | { kind: 'session'; role: SessionRole; live: boolean }
  | { kind: 'person'; owner: boolean; administrator: boolean }
  | { kind: 'service' };

export type TransitionRequest = {
  taskKind: 'root' | 'child';
  from: TaskState;
  to: TaskState;
  verificationMode: VerificationMode;
  nextVerificationMode: VerificationMode | null;
  actor: TransitionActor;
  note: string;
  evidence: EvidenceEntry[];
  childCount: number;
  openChildCount: number;
  failedChildCount: number;
  implementerEverStarted: boolean;
};

export type TransitionDecision =
  | {
      ok: true;
      to: TaskState;
      verificationMode: VerificationMode;
      modeChanged: boolean;
      incrementChangesetRound: boolean;
    }
  | {
      ok: false;
      code: 'invalid_transition' | 'condition_not_met' | 'evidence_required' | 'children_open';
      message: string;
      details: ErrorDetails;
    };

type EvidenceNeed = 'note' | 'address' | 'address_or_description';

type Condition =
  | 'mode_before_or_both'
  | 'mode_after'
  | 'mode_before'
  | 'mode_after_or_both'
  | 'at_least_one_child'
  | 'solo_goal'
  | 'every_child_closed'
  | 'every_child_done';

type Reporter =
  | 'implementer'
  | 'reviewer'
  | 'verifier'
  | 'planner'
  | 'fail'
  | 'root_done'
  | 'service_done';

type Row = {
  id: string;
  scope: 'child' | 'root';
  from: TaskState | 'any_open';
  to: TaskState;
  reporter: Reporter;
  evidence: EvidenceNeed;
  condition?: Condition;
  incrementRound?: boolean;
};

const modeOrder: readonly VerificationMode[] = ['before_merge', 'both', 'after_merge'];

const rows: readonly Row[] = [
  {
    id: 'C1',
    scope: 'child',
    from: 'planned',
    to: 'implementing',
    reporter: 'implementer',
    evidence: 'note',
  },
  {
    id: 'C2',
    scope: 'child',
    from: 'implementing',
    to: 'in_review',
    reporter: 'implementer',
    evidence: 'address',
  },
  {
    id: 'C3',
    scope: 'child',
    from: 'in_review',
    to: 'implementing',
    reporter: 'reviewer',
    evidence: 'note',
  },
  {
    id: 'C4',
    scope: 'child',
    from: 'in_review',
    to: 'approved',
    reporter: 'reviewer',
    evidence: 'address',
  },
  {
    id: 'C5',
    scope: 'child',
    from: 'approved',
    to: 'verifying_before_merge',
    reporter: 'reviewer',
    evidence: 'note',
    condition: 'mode_before_or_both',
  },
  {
    id: 'C6',
    scope: 'child',
    from: 'approved',
    to: 'merging',
    reporter: 'reviewer',
    evidence: 'note',
    condition: 'mode_after',
  },
  {
    id: 'C7',
    scope: 'child',
    from: 'verifying_before_merge',
    to: 'merging',
    reporter: 'verifier',
    evidence: 'address_or_description',
  },
  {
    id: 'C8',
    scope: 'child',
    from: 'verifying_before_merge',
    to: 'implementing',
    reporter: 'verifier',
    evidence: 'note',
  },
  {
    id: 'C9',
    scope: 'child',
    from: 'merging',
    to: 'done',
    reporter: 'reviewer',
    evidence: 'address',
    condition: 'mode_before',
  },
  {
    id: 'C10',
    scope: 'child',
    from: 'merging',
    to: 'verifying_after_merge',
    reporter: 'reviewer',
    evidence: 'address',
    condition: 'mode_after_or_both',
  },
  {
    id: 'C11',
    scope: 'child',
    from: 'merging',
    to: 'implementing',
    reporter: 'reviewer',
    evidence: 'note',
  },
  {
    id: 'C12',
    scope: 'child',
    from: 'verifying_after_merge',
    to: 'done',
    reporter: 'verifier',
    evidence: 'address_or_description',
  },
  {
    id: 'C13',
    scope: 'child',
    from: 'verifying_after_merge',
    to: 'implementing',
    reporter: 'verifier',
    evidence: 'note',
    incrementRound: true,
  },
  { id: 'C14', scope: 'child', from: 'any_open', to: 'failed', reporter: 'fail', evidence: 'note' },
  {
    id: 'R1',
    scope: 'root',
    from: 'planned',
    to: 'analyzing',
    reporter: 'planner',
    evidence: 'note',
  },
  {
    id: 'R2',
    scope: 'root',
    from: 'analyzing',
    to: 'implementing',
    reporter: 'planner',
    evidence: 'note',
    condition: 'at_least_one_child',
  },
  {
    id: 'R3',
    scope: 'root',
    from: 'analyzing',
    to: 'done',
    reporter: 'planner',
    evidence: 'address',
    condition: 'solo_goal',
  },
  {
    id: 'R4',
    scope: 'root',
    from: 'implementing',
    to: 'done',
    reporter: 'root_done',
    evidence: 'note',
    condition: 'every_child_closed',
  },
  {
    id: 'R4',
    scope: 'root',
    from: 'implementing',
    to: 'done',
    reporter: 'service_done',
    evidence: 'note',
    condition: 'every_child_done',
  },
  { id: 'R5', scope: 'root', from: 'any_open', to: 'failed', reporter: 'fail', evidence: 'note' },
];

/**
 * Decide whether a report may change a task. The mode on the report is applied
 * before the row is chosen, so a later mode can make the same report legal.
 */
export function decideTransition(input: TransitionRequest): TransitionDecision {
  if (isClosedState(input.from)) {
    return refuse('invalid_transition', 'A closed task cannot change state.', input);
  }

  const mode = resolveMode(input);

  if (!mode.ok) return mode.decision;

  const candidates = rows.filter(
    row =>
      row.scope === input.taskKind &&
      row.to === input.to &&
      fromMatches(row, input.from) &&
      reporterMatches(row, input.actor, input.taskKind, input.from)
  );
  const matched = candidates.find(row =>
    conditionHolds(row.condition, input, mode.verificationMode)
  );

  if (matched === undefined) {
    if (
      input.openChildCount > 0 &&
      candidates.some(
        row => row.condition === 'every_child_closed' || row.condition === 'every_child_done'
      )
    ) {
      return {
        ok: false,
        code: 'children_open',
        message: 'The root task cannot close while a child task is open.',
        details: {
          open_child_count: input.openChildCount,
          current_state: input.from,
          requested_state: input.to,
        },
      };
    }

    if (candidates.length > 0) {
      return {
        ok: false,
        code: 'condition_not_met',
        message: 'The transition condition does not hold.',
        details: {
          condition: candidates[0]?.condition ?? 'unknown',
          current_state: input.from,
          requested_state: input.to,
        },
      };
    }

    return refuse('invalid_transition', 'That transition is not in the table.', input);
  }

  if (!evidenceOk(matched.evidence, input.note, input.evidence)) {
    return {
      ok: false,
      code: 'evidence_required',
      message: 'The report needs a note and the evidence this transition asks for.',
      details: { current_state: input.from, requested_state: input.to },
    };
  }

  return {
    ok: true,
    to: input.to,
    verificationMode: mode.verificationMode,
    modeChanged: mode.changed,
    incrementChangesetRound: matched.incrementRound === true,
  };
}

function resolveMode(
  input: TransitionRequest
):
  | { ok: true; verificationMode: VerificationMode; changed: boolean }
  | { ok: false; decision: TransitionDecision } {
  const next = input.nextVerificationMode;

  if (next === null || next === input.verificationMode) {
    return { ok: true, verificationMode: input.verificationMode, changed: false };
  }

  const reviewer = input.actor.kind === 'session' && input.actor.role === 'reviewer';
  const later = modeOrder.indexOf(next) > modeOrder.indexOf(input.verificationMode);

  if (input.taskKind !== 'child' || !reviewer || !later) {
    return {
      ok: false,
      decision: {
        ok: false,
        code: 'condition_not_met',
        message: 'Only a reviewer can move verification to a later mode.',
        details: {
          condition: 'later_verification_mode',
          current_state: input.from,
          requested_state: input.to,
        },
      },
    };
  }

  return { ok: true, verificationMode: next, changed: true };
}

function fromMatches(row: Row, from: TaskState): boolean {
  if (row.from === 'any_open') return !isClosedState(from);

  return row.from === from;
}

function reporterMatches(
  row: Row,
  actor: TransitionActor,
  scope: 'root' | 'child',
  from: TaskState
): boolean {
  switch (row.reporter) {
    case 'implementer':
    case 'reviewer':
    case 'verifier':
    case 'planner':
      return actor.kind === 'session' && actor.role === row.reporter;
    case 'fail':
      return canFail(actor, scope, from);
    case 'root_done':
      if (actor.kind === 'session' && actor.role === 'planner') return true;
      return actor.kind === 'person' && (actor.owner || actor.administrator);
    case 'service_done':
      return actor.kind === 'service';
    default: {
      const neverReporter: never = row.reporter;
      return neverReporter;
    }
  }
}

/**
 * A released session can fail only where it can already report a transition.
 * A live planner can fail any open task, which is the extra authority in the policy.
 */
function canFail(actor: TransitionActor, scope: 'root' | 'child', from: TaskState): boolean {
  if (isClosedState(from)) return false;
  if (actor.kind === 'person' && (actor.owner || actor.administrator)) return true;
  if (actor.kind !== 'session') return false;
  if (actor.role === 'planner' && actor.live) return true;

  return hasOutbound(scope, from, actor.role);
}

function hasOutbound(scope: 'root' | 'child', from: TaskState, role: SessionRole): boolean {
  return rows.some(row => {
    if (row.scope !== scope || row.to === 'failed') return false;
    if (row.reporter !== role && !(row.reporter === 'root_done' && role === 'planner'))
      return false;
    if (row.from === 'any_open') return !isClosedState(from);

    return row.from === from;
  });
}

function conditionHolds(
  condition: Condition | undefined,
  input: TransitionRequest,
  mode: VerificationMode
): boolean {
  switch (condition) {
    case undefined:
      return true;
    case 'mode_before_or_both':
      return mode === 'before_merge' || mode === 'both';
    case 'mode_after':
      return mode === 'after_merge';
    case 'mode_before':
      return mode === 'before_merge';
    case 'mode_after_or_both':
      return mode === 'after_merge' || mode === 'both';
    case 'at_least_one_child':
      return input.childCount >= 1;
    case 'solo_goal':
      return input.childCount === 0 && !input.implementerEverStarted;
    case 'every_child_closed':
      return input.childCount > 0 && input.openChildCount === 0;
    case 'every_child_done':
      return input.childCount > 0 && input.openChildCount === 0 && input.failedChildCount === 0;
    default: {
      const neverCondition: never = condition;
      return neverCondition;
    }
  }
}

function evidenceOk(need: EvidenceNeed, note: string, evidence: EvidenceEntry[]): boolean {
  if (note.trim().length === 0 || Buffer.byteLength(note) > 4 * 1024) return false;
  if (evidence.some(entry => !entryShapeOk(entry))) return false;
  if (need === 'note') return true;

  if (need === 'address') {
    return evidence.some(entry => entry.kind === 'address' && isWebAddress(entry.value));
  }

  return evidence.some(entry => entry.value.trim().length > 0);
}

function entryShapeOk(entry: EvidenceEntry): boolean {
  if (entry.label.trim().length === 0 || entry.label.length > 40) return false;
  if (entry.value.trim().length === 0 || Buffer.byteLength(entry.value) > 2048) return false;
  if (entry.kind === 'address') return isWebAddress(entry.value);

  return true;
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function refuse(
  code: 'invalid_transition',
  message: string,
  input: TransitionRequest
): TransitionDecision {
  return {
    ok: false,
    code,
    message,
    details: { current_state: input.from, requested_state: input.to },
  };
}
