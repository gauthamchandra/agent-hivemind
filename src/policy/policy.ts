import { HivemindError } from '@/domain/errors.ts';
import type { SessionRole, TaskState } from '@/domain/model.ts';
import { isClosedState, sessionRoles } from '@/domain/model.ts';

export const policyActions = [
  'read_task',
  'create_child_task',
  'edit_child_task',
  'report_transition',
  'fail_task',
  'move_verification_mode',
  'add_note',
  'list_members',
  'start_member',
  'start_replacement',
  'release_self',
  'end_self',
  'end_other',
  'report_environment',
  'send_one',
  'send_all',
  'record_wait',
  'read_messages',
  'escalate',
] as const;

export type PolicyAction = (typeof policyActions)[number];

export type PolicyInput = {
  role: SessionRole;
  action: PolicyAction;
  released: boolean;
  taskKind: 'root' | 'child';
  taskState: TaskState;
  relation: 'own' | 'other';
  rootState: TaskState;
  targetRole: SessionRole;
  targetStartedByCaller: boolean;
  targetTaskClosed: boolean;
};

export type PolicyRule = {
  action: PolicyAction;
  roles: readonly SessionRole[];
  released: 'live' | 'either';
  taskKind?: 'root' | 'child';
  taskStates?: readonly TaskState[];
  relation?: 'own';
  targetRoles?: readonly SessionRole[];
  targetStartedByCaller?: true;
  targetTaskClosed?: true;
  taskOpen?: true;
  taskClosed?: true;
  rootOpen?: true;
  rootStates?: readonly TaskState[];
};

export type PolicyDecision = {
  allowed: boolean;
  role: SessionRole;
  action: PolicyAction;
  message: string;
};

const everyone = sessionRoles;

function allow(
  action: PolicyAction,
  roles: readonly SessionRole[],
  released: 'live' | 'either'
): PolicyRule {
  return { action, roles, released };
}

function startRules(action: 'start_member' | 'start_replacement'): PolicyRule[] {
  return [
    { ...allow(action, ['planner'], 'live'), targetRoles: ['challenger'], taskKind: 'root' },
    {
      ...allow(action, ['planner'], 'live'),
      targetRoles: ['implementer'],
      taskKind: 'child',
      taskStates: ['planned', 'implementing'],
      rootOpen: true,
    },
    {
      ...allow(action, ['implementer'], 'live'),
      targetRoles: ['reviewer'],
      relation: 'own',
      taskStates: ['implementing'],
    },
    {
      ...allow(action, ['reviewer'], 'live'),
      targetRoles: ['verifier'],
      relation: 'own',
      taskStates: ['in_review', 'approved', 'merging'],
    },
  ];
}

/**
 * Replacement uses the same edges as a first start. The table names the role,
 * and the state limits on that edge still apply, or a replacement would bypass them.
 */
export const policyRules: readonly PolicyRule[] = [
  allow('read_task', everyone, 'either'),
  allow('list_members', everyone, 'either'),
  allow('send_one', everyone, 'either'),
  allow('record_wait', everyone, 'either'),
  allow('read_messages', everyone, 'either'),
  allow('escalate', everyone, 'either'),
  allow('send_all', ['planner'], 'either'),
  allow('report_environment', everyone, 'live'),
  allow('release_self', everyone, 'live'),
  { ...allow('create_child_task', ['planner'], 'live'), rootStates: ['analyzing', 'implementing'] },
  {
    ...allow('edit_child_task', ['planner'], 'live'),
    taskKind: 'child',
    taskStates: ['planned'],
  },
  { ...allow('report_transition', ['planner'], 'either'), taskKind: 'root', relation: 'own' },
  { ...allow('report_transition', ['implementer'], 'either'), taskKind: 'child', relation: 'own' },
  { ...allow('report_transition', ['reviewer'], 'either'), taskKind: 'child', relation: 'own' },
  { ...allow('report_transition', ['verifier'], 'either'), taskKind: 'child', relation: 'own' },
  { ...allow('fail_task', ['planner'], 'live'), taskOpen: true },
  {
    ...allow('fail_task', ['planner'], 'either'),
    taskKind: 'root',
    relation: 'own',
    taskOpen: true,
  },
  {
    ...allow('fail_task', ['implementer'], 'either'),
    taskKind: 'child',
    relation: 'own',
    taskStates: ['planned', 'implementing'],
  },
  {
    ...allow('fail_task', ['reviewer'], 'either'),
    taskKind: 'child',
    relation: 'own',
    taskStates: ['in_review', 'approved', 'merging'],
  },
  {
    ...allow('fail_task', ['verifier'], 'either'),
    taskKind: 'child',
    relation: 'own',
    taskStates: ['verifying_before_merge', 'verifying_after_merge'],
  },
  {
    ...allow('move_verification_mode', ['reviewer'], 'either'),
    taskKind: 'child',
    relation: 'own',
  },
  allow('add_note', ['planner'], 'either'),
  { ...allow('add_note', ['challenger'], 'either'), taskKind: 'root' },
  { ...allow('add_note', ['implementer', 'reviewer', 'verifier'], 'either'), relation: 'own' },
  ...startRules('start_member'),
  ...startRules('start_replacement'),
  allow('end_self', ['planner', 'challenger', 'verifier'], 'either'),
  { ...allow('end_self', ['implementer', 'reviewer'], 'either'), taskClosed: true },
  { ...allow('end_other', ['planner'], 'live'), targetStartedByCaller: true },
  { ...allow('end_other', ['planner'], 'live'), targetTaskClosed: true },
  {
    ...allow('end_other', ['implementer'], 'live'),
    targetStartedByCaller: true,
    targetTaskClosed: true,
  },
  { ...allow('end_other', ['reviewer'], 'live'), targetStartedByCaller: true },
];

export function matchesPolicyRule(rule: PolicyRule, input: PolicyInput): boolean {
  if (rule.action !== input.action) return false;
  if (!rule.roles.includes(input.role)) return false;
  if (rule.released === 'live' && input.released) return false;
  if (rule.taskKind !== undefined && rule.taskKind !== input.taskKind) return false;
  if (rule.taskStates !== undefined && !rule.taskStates.includes(input.taskState)) return false;
  if (rule.rootStates !== undefined && !rule.rootStates.includes(input.rootState)) return false;
  if (rule.relation === 'own' && input.relation !== 'own') return false;
  if (rule.targetRoles !== undefined && !rule.targetRoles.includes(input.targetRole)) return false;
  if (rule.targetStartedByCaller === true && !input.targetStartedByCaller) return false;
  if (rule.targetTaskClosed === true && !input.targetTaskClosed) return false;
  if (rule.taskOpen === true && isClosedState(input.taskState)) return false;
  if (rule.taskClosed === true && !isClosedState(input.taskState)) return false;
  if (rule.rootOpen === true && isClosedState(input.rootState)) return false;

  return true;
}

export function requireAllowed(input: PolicyInput): void {
  const decision = evaluatePolicy(input);

  if (!decision.allowed) {
    throw new HivemindError('policy_denied', decision.message, {
      role: decision.role,
      action: decision.action,
    });
  }
}

export function evaluatePolicy(input: PolicyInput): PolicyDecision {
  const allowed = policyRules.some(rule => matchesPolicyRule(rule, input));

  return {
    allowed,
    role: input.role,
    action: input.action,
    message: allowed
      ? `The ${input.role} role may ${input.action}.`
      : `The ${input.role} role cannot ${input.action}.`,
  };
}
