import type { EvidenceEntry, SessionRole, TaskState, VerificationMode } from '@/domain/model.ts';
import { isClosedState } from '@/domain/model.ts';
import { type Condition, type EvidenceNeed, type Row, rows } from '@/domain/transition-rows.ts';
import type {
  TransitionActor,
  TransitionDecision,
  TransitionRequest,
} from '@/domain/transitions.ts';

export function fromMatches(row: Row, from: TaskState): boolean {
  if (row.from === 'any_open') return !isClosedState(from);

  return row.from === from;
}

export function reporterMatches(
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
export function canFail(actor: TransitionActor, scope: 'root' | 'child', from: TaskState): boolean {
  if (isClosedState(from)) return false;
  if (actor.kind === 'person' && (actor.owner || actor.administrator)) return true;
  if (actor.kind !== 'session') return false;
  if (actor.role === 'planner' && actor.live) return true;

  return hasOutbound(scope, from, actor.role);
}

export function hasOutbound(scope: 'root' | 'child', from: TaskState, role: SessionRole): boolean {
  return rows.some(row => {
    if (row.scope !== scope || row.to === 'failed') return false;
    if (row.reporter !== role && !(row.reporter === 'root_done' && role === 'planner'))
      return false;
    if (row.from === 'any_open') return !isClosedState(from);

    return row.from === from;
  });
}

export function conditionHolds(
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

export function evidenceOk(need: EvidenceNeed, note: string, evidence: EvidenceEntry[]): boolean {
  if (note.trim().length === 0 || Buffer.byteLength(note) > 4 * 1024) return false;
  if (evidence.some(entry => !entryShapeOk(entry))) return false;
  if (need === 'note') return true;

  if (need === 'address') {
    return evidence.some(entry => entry.kind === 'address' && isWebAddress(entry.value));
  }

  return evidence.some(entry => entry.value.trim().length > 0);
}

export function entryShapeOk(entry: EvidenceEntry): boolean {
  if (entry.label.trim().length === 0 || entry.label.length > 40) return false;
  if (entry.value.trim().length === 0 || Buffer.byteLength(entry.value) > 2048) return false;
  if (entry.kind === 'address') return isWebAddress(entry.value);

  return true;
}

export function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function refuse(
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
