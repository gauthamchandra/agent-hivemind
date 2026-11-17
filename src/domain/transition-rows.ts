import type { TaskState } from '@/domain/model.ts';

export type EvidenceNeed = 'note' | 'address' | 'address_or_description';

export type Condition =
  | 'mode_before_or_both'
  | 'mode_after'
  | 'mode_before'
  | 'mode_after_or_both'
  | 'at_least_one_child'
  | 'solo_goal'
  | 'every_child_closed'
  | 'every_child_done';

export type Reporter =
  | 'implementer'
  | 'reviewer'
  | 'verifier'
  | 'planner'
  | 'fail'
  | 'root_done'
  | 'service_done';

export type Row = {
  id: string;
  scope: 'child' | 'root';
  from: TaskState | 'any_open';
  to: TaskState;
  reporter: Reporter;
  evidence: EvidenceNeed;
  condition?: Condition;
  incrementRound?: boolean;
};

export const rows: readonly Row[] = [
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
