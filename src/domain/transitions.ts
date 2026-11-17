import type { ErrorDetails } from '@/domain/errors.ts';
import type { EvidenceEntry, SessionRole, TaskState, VerificationMode } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import {
  conditionHolds,
  evidenceOk,
  fromMatches,
  refuse,
  reporterMatches,
} from '@/domain/transition-match.ts';
import { rows } from '@/domain/transition-rows.ts';

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

const modeOrder: readonly VerificationMode[] = ['before_merge', 'both', 'after_merge'];

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
