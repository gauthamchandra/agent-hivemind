import { describe, expect, test } from 'bun:test';
import type { SessionRole, TaskState, VerificationMode } from '@/domain/model.ts';
import type {
  TransitionActor,
  TransitionDecision,
  TransitionRequest,
} from '@/domain/transitions.ts';
import { decideTransition } from '@/domain/transitions.ts';

const note = 'Cited from the work that just finished.';
const address = [
  { label: 'pull request', kind: 'address' as const, value: 'https://example.com/pr/1' },
];
const description = [{ label: 'check', kind: 'text' as const, value: 'the suite passed' }];

type EvidenceKind = 'note' | 'address' | 'address_or_description';

function session(role: SessionRole, live = true): TransitionActor {
  return { kind: 'session', role, live };
}

function request(overrides: {
  taskKind: 'root' | 'child';
  from: TaskState;
  to: TaskState;
  actor: TransitionActor;
  verificationMode?: VerificationMode;
  nextVerificationMode?: VerificationMode | null;
  note?: string | undefined;
  evidence?: TransitionRequest['evidence'] | undefined;
  childCount?: number | undefined;
  openChildCount?: number | undefined;
  failedChildCount?: number | undefined;
  implementerEverStarted?: boolean | undefined;
}): TransitionRequest {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined)
  );

  return {
    verificationMode: 'before_merge',
    nextVerificationMode: null,
    note,
    evidence: [],
    childCount: 0,
    openChildCount: 0,
    failedChildCount: 0,
    implementerEverStarted: false,
    taskKind: overrides.taskKind,
    from: overrides.from,
    to: overrides.to,
    actor: overrides.actor,
    ...defined,
  };
}

function evidenceFor(kind: EvidenceKind): TransitionRequest['evidence'] {
  if (kind === 'address') return address;
  if (kind === 'address_or_description') return description;
  return [];
}

function expectAccepted(
  decision: TransitionDecision,
  expected: { to: TaskState; round: boolean; mode?: VerificationMode }
): void {
  expect(decision.ok).toBe(true);
  if (!decision.ok) return;

  expect(decision.to).toBe(expected.to);
  expect(decision.incrementChangesetRound).toBe(expected.round);
  if (expected.mode !== undefined) {
    expect(decision.verificationMode).toBe(expected.mode);
  }
}

function expectRefused(
  decision: TransitionDecision,
  code: Extract<TransitionDecision, { ok: false }>['code']
): void {
  expect(decision.ok).toBe(false);
  if (decision.ok) return;

  expect(decision.code).toBe(code);
}

type AcceptCase = {
  id: string;
  taskKind: 'root' | 'child';
  from: TaskState;
  to: TaskState;
  actor: TransitionActor;
  evidence: EvidenceKind;
  mode?: VerificationMode;
  childCount?: number;
  openChildCount?: number;
  failedChildCount?: number;
  implementerEverStarted?: boolean;
  round?: boolean;
  conditionFailure?: Partial<TransitionRequest>;
  conditionCode?: 'condition_not_met' | 'children_open';
};

const cases: AcceptCase[] = [
  {
    id: 'C1',
    taskKind: 'child',
    from: 'planned',
    to: 'implementing',
    actor: session('implementer'),
    evidence: 'note',
  },
  {
    id: 'C2',
    taskKind: 'child',
    from: 'implementing',
    to: 'in_review',
    actor: session('implementer'),
    evidence: 'address',
  },
  {
    id: 'C3',
    taskKind: 'child',
    from: 'in_review',
    to: 'implementing',
    actor: session('reviewer'),
    evidence: 'note',
  },
  {
    id: 'C4',
    taskKind: 'child',
    from: 'in_review',
    to: 'approved',
    actor: session('reviewer'),
    evidence: 'address',
  },
  {
    id: 'C5',
    taskKind: 'child',
    from: 'approved',
    to: 'verifying_before_merge',
    actor: session('reviewer'),
    evidence: 'note',
    mode: 'before_merge',
    conditionFailure: { verificationMode: 'after_merge' },
  },
  {
    id: 'C5 both',
    taskKind: 'child',
    from: 'approved',
    to: 'verifying_before_merge',
    actor: session('reviewer'),
    evidence: 'note',
    mode: 'both',
  },
  {
    id: 'C6',
    taskKind: 'child',
    from: 'approved',
    to: 'merging',
    actor: session('reviewer'),
    evidence: 'note',
    mode: 'after_merge',
    conditionFailure: { verificationMode: 'before_merge' },
  },
  {
    id: 'C7',
    taskKind: 'child',
    from: 'verifying_before_merge',
    to: 'merging',
    actor: session('verifier'),
    evidence: 'address_or_description',
  },
  {
    id: 'C8',
    taskKind: 'child',
    from: 'verifying_before_merge',
    to: 'implementing',
    actor: session('verifier'),
    evidence: 'note',
  },
  {
    id: 'C9',
    taskKind: 'child',
    from: 'merging',
    to: 'done',
    actor: session('reviewer'),
    evidence: 'address',
    mode: 'before_merge',
    conditionFailure: { verificationMode: 'after_merge' },
  },
  {
    id: 'C10',
    taskKind: 'child',
    from: 'merging',
    to: 'verifying_after_merge',
    actor: session('reviewer'),
    evidence: 'address',
    mode: 'after_merge',
    conditionFailure: { verificationMode: 'before_merge' },
  },
  {
    id: 'C10 both',
    taskKind: 'child',
    from: 'merging',
    to: 'verifying_after_merge',
    actor: session('reviewer'),
    evidence: 'address',
    mode: 'both',
  },
  {
    id: 'C11',
    taskKind: 'child',
    from: 'merging',
    to: 'implementing',
    actor: session('reviewer'),
    evidence: 'note',
  },
  {
    id: 'C12',
    taskKind: 'child',
    from: 'verifying_after_merge',
    to: 'done',
    actor: session('verifier'),
    evidence: 'address_or_description',
  },
  {
    id: 'C13',
    taskKind: 'child',
    from: 'verifying_after_merge',
    to: 'implementing',
    actor: session('verifier'),
    evidence: 'note',
    round: true,
  },
  {
    id: 'R1',
    taskKind: 'root',
    from: 'planned',
    to: 'analyzing',
    actor: session('planner'),
    evidence: 'note',
  },
  {
    id: 'R2',
    taskKind: 'root',
    from: 'analyzing',
    to: 'implementing',
    actor: session('planner'),
    evidence: 'note',
    childCount: 1,
    openChildCount: 1,
    conditionFailure: { childCount: 0, openChildCount: 0 },
  },
  {
    id: 'R3',
    taskKind: 'root',
    from: 'analyzing',
    to: 'done',
    actor: session('planner'),
    evidence: 'address',
    conditionFailure: { childCount: 1, openChildCount: 1 },
  },
  {
    id: 'R4',
    taskKind: 'root',
    from: 'implementing',
    to: 'done',
    actor: session('planner'),
    evidence: 'note',
    childCount: 1,
    openChildCount: 0,
    failedChildCount: 0,
    conditionFailure: { openChildCount: 1, childCount: 1 },
    conditionCode: 'children_open',
  },
  {
    id: 'R5',
    taskKind: 'root',
    from: 'analyzing',
    to: 'failed',
    actor: session('planner'),
    evidence: 'note',
    childCount: 1,
    openChildCount: 1,
  },
];

describe('task transitions', () => {
  for (const item of cases) {
    test(`${item.id} accepts ${item.from} -> ${item.to} with the required evidence`, () => {
      const decision = decideTransition(
        request({
          taskKind: item.taskKind,
          from: item.from,
          to: item.to,
          actor: item.actor,
          verificationMode: item.mode ?? 'before_merge',
          evidence: evidenceFor(item.evidence),
          childCount: item.childCount,
          openChildCount: item.openChildCount,
          failedChildCount: item.failedChildCount,
          implementerEverStarted: item.implementerEverStarted,
        })
      );

      expectAccepted(
        decision,
        item.mode === undefined
          ? { to: item.to, round: item.round ?? false }
          : { to: item.to, round: item.round ?? false, mode: item.mode }
      );
    });

    test(`${item.id} refuses a role that cannot report it`, () => {
      const decision = decideTransition(
        request({
          taskKind: item.taskKind,
          from: item.from,
          to: item.to,
          actor: session('challenger'),
          verificationMode: item.mode ?? 'before_merge',
          evidence: evidenceFor(item.evidence),
          childCount: item.childCount,
          openChildCount: item.openChildCount,
          failedChildCount: item.failedChildCount,
        })
      );

      expectRefused(decision, 'invalid_transition');
    });

    test(`${item.id} refuses an empty note`, () => {
      const decision = decideTransition(
        request({
          taskKind: item.taskKind,
          from: item.from,
          to: item.to,
          actor: item.actor,
          verificationMode: item.mode ?? 'before_merge',
          note: '   ',
          evidence: evidenceFor(item.evidence),
          childCount: item.childCount,
          openChildCount: item.openChildCount,
          failedChildCount: item.failedChildCount,
        })
      );

      expectRefused(decision, 'evidence_required');
    });

    if (item.evidence === 'address' || item.evidence === 'address_or_description') {
      test(`${item.id} refuses a report that lacks the required evidence entry`, () => {
        const decision = decideTransition(
          request({
            taskKind: item.taskKind,
            from: item.from,
            to: item.to,
            actor: item.actor,
            verificationMode: item.mode ?? 'before_merge',
            evidence: item.evidence === 'address' ? description : [],
            childCount: item.childCount,
            openChildCount: item.openChildCount,
            failedChildCount: item.failedChildCount,
          })
        );

        expectRefused(decision, 'evidence_required');
      });
    }

    if (item.conditionFailure !== undefined) {
      test(`${item.id} refuses when its condition does not hold`, () => {
        const decision = decideTransition(
          request({
            taskKind: item.taskKind,
            from: item.from,
            to: item.to,
            actor: item.actor,
            verificationMode: item.mode ?? 'before_merge',
            evidence: evidenceFor(item.evidence),
            childCount: item.childCount,
            openChildCount: item.openChildCount,
            failedChildCount: item.failedChildCount,
            ...item.conditionFailure,
          })
        );

        expectRefused(decision, item.conditionCode ?? 'condition_not_met');
      });
    }
  }

  test('a released implementer can still report the transition for its own task', () => {
    const decision = decideTransition(
      request({
        taskKind: 'child',
        from: 'planned',
        to: 'implementing',
        actor: session('implementer', false),
      })
    );

    expectAccepted(decision, { to: 'implementing', round: false });
  });

  test('an owner and a workspace administrator can fail an open task', () => {
    for (const actor of [
      { kind: 'person' as const, owner: true, administrator: false },
      { kind: 'person' as const, owner: false, administrator: true },
    ]) {
      const decision = decideTransition(
        request({ taskKind: 'child', from: 'in_review', to: 'failed', actor })
      );

      expectAccepted(decision, { to: 'failed', round: false });
    }
  });

  test('a live planner can fail a child task, and a released planner cannot', () => {
    const live = decideTransition(
      request({
        taskKind: 'child',
        from: 'in_review',
        to: 'failed',
        actor: session('planner', true),
      })
    );
    const released = decideTransition(
      request({
        taskKind: 'child',
        from: 'in_review',
        to: 'failed',
        actor: session('planner', false),
      })
    );

    expectAccepted(live, { to: 'failed', round: false });
    expectRefused(released, 'invalid_transition');
  });

  test('the service closes the root only when every child is done', () => {
    const done = decideTransition(
      request({
        taskKind: 'root',
        from: 'implementing',
        to: 'done',
        actor: { kind: 'service' },
        childCount: 2,
        openChildCount: 0,
        failedChildCount: 0,
      })
    );
    const mixed = decideTransition(
      request({
        taskKind: 'root',
        from: 'implementing',
        to: 'done',
        actor: { kind: 'service' },
        childCount: 2,
        openChildCount: 0,
        failedChildCount: 1,
      })
    );

    expectAccepted(done, { to: 'done', round: false });
    expectRefused(mixed, 'condition_not_met');
  });

  test('the owner can close the root when a child failed and none remain open', () => {
    const decision = decideTransition(
      request({
        taskKind: 'root',
        from: 'implementing',
        to: 'done',
        actor: { kind: 'person', owner: true, administrator: false },
        childCount: 2,
        openChildCount: 0,
        failedChildCount: 1,
      })
    );

    expectAccepted(decision, { to: 'done', round: false });
  });

  test('a solo goal needs evidence and no prior implementer', () => {
    const started = decideTransition(
      request({
        taskKind: 'root',
        from: 'analyzing',
        to: 'done',
        actor: session('planner'),
        evidence: address,
        implementerEverStarted: true,
      })
    );

    expectRefused(started, 'condition_not_met');
  });

  test('a closed task never changes state', () => {
    const decision = decideTransition(
      request({
        taskKind: 'child',
        from: 'done',
        to: 'implementing',
        actor: session('implementer'),
      })
    );

    expectRefused(decision, 'invalid_transition');
    if (!decision.ok) {
      expect(decision.details.current_state).toBe('done');
      expect(decision.details.requested_state).toBe('implementing');
    }
  });

  test('the reviewer can move verification later before the transition is judged', () => {
    const decision = decideTransition(
      request({
        taskKind: 'child',
        from: 'approved',
        to: 'merging',
        actor: session('reviewer'),
        verificationMode: 'before_merge',
        nextVerificationMode: 'after_merge',
      })
    );

    expectAccepted(decision, { to: 'merging', round: false, mode: 'after_merge' });
    if (decision.ok) expect(decision.modeChanged).toBe(true);
  });

  test('verification cannot move earlier', () => {
    const decision = decideTransition(
      request({
        taskKind: 'child',
        from: 'approved',
        to: 'merging',
        actor: session('reviewer'),
        verificationMode: 'after_merge',
        nextVerificationMode: 'before_merge',
        evidence: address,
      })
    );

    expectRefused(decision, 'condition_not_met');
  });

  test('a child transition does not apply to the root task', () => {
    const decision = decideTransition(
      request({
        taskKind: 'root',
        from: 'planned',
        to: 'implementing',
        actor: session('implementer'),
      })
    );

    expectRefused(decision, 'invalid_transition');
  });

  test('an address that is not a web address is refused', () => {
    const decision = decideTransition(
      request({
        taskKind: 'child',
        from: 'implementing',
        to: 'in_review',
        actor: session('implementer'),
        evidence: [{ label: 'pull request', kind: 'address', value: 'not a url' }],
      })
    );

    expectRefused(decision, 'evidence_required');
  });

  test('failing the root is allowed while child tasks are open', () => {
    const decision = decideTransition(
      request({
        taskKind: 'root',
        from: 'implementing',
        to: 'failed',
        actor: { kind: 'person', owner: true, administrator: false },
        childCount: 1,
        openChildCount: 1,
      })
    );

    expectAccepted(decision, { to: 'failed', round: false });
  });
});
