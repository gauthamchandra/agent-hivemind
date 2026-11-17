import { describe, expect, test } from 'bun:test';
import type { SessionRole, TaskState } from '@/domain/model.ts';
import { isClosedState, sessionRoles, taskStates } from '@/domain/model.ts';
import type { PolicyAction, PolicyInput } from '@/policy/policy.ts';
import { evaluatePolicy, matchesPolicyRule, policyActions, policyRules } from '@/policy/policy.ts';

const relations = ['own', 'other'] as const;
const taskKinds = ['root', 'child'] as const;

function specAllows(input: PolicyInput): boolean {
  const { action, role, released, taskKind, taskState, relation, rootState, targetRole } = input;
  const rootOpen = !isClosedState(rootState);

  switch (action) {
    case 'read_task':
    case 'list_members':
    case 'send_one':
    case 'record_wait':
    case 'read_messages':
    case 'escalate':
      return true;
    case 'send_all':
      return role === 'planner';
    case 'report_environment':
    case 'release_self':
      return !released;
    case 'create_child_task':
      return (
        role === 'planner' &&
        !released &&
        (rootState === 'analyzing' || rootState === 'implementing')
      );
    case 'edit_child_task':
      return role === 'planner' && !released && taskKind === 'child' && taskState === 'planned';
    case 'report_transition':
      if (role === 'planner') return taskKind === 'root' && relation === 'own';
      if (role === 'implementer' || role === 'reviewer' || role === 'verifier') {
        return taskKind === 'child' && relation === 'own';
      }
      return false;
    case 'fail_task':
      if (isClosedState(taskState)) return false;
      if (role === 'planner' && !released) return true;
      if (role === 'planner') {
        return taskKind === 'root' && relation === 'own';
      }
      if (released && role !== 'implementer' && role !== 'reviewer' && role !== 'verifier') {
        return false;
      }
      if (role === 'implementer') {
        return (
          taskKind === 'child' &&
          relation === 'own' &&
          (taskState === 'planned' || taskState === 'implementing')
        );
      }
      if (role === 'reviewer') {
        return (
          taskKind === 'child' &&
          relation === 'own' &&
          (taskState === 'in_review' || taskState === 'approved' || taskState === 'merging')
        );
      }
      if (role === 'verifier') {
        return (
          taskKind === 'child' &&
          relation === 'own' &&
          (taskState === 'verifying_before_merge' || taskState === 'verifying_after_merge')
        );
      }
      return false;
    case 'move_verification_mode':
      return role === 'reviewer' && taskKind === 'child' && relation === 'own';
    case 'add_note':
      if (role === 'planner') return true;
      if (role === 'challenger') return taskKind === 'root';
      if (role === 'implementer' || role === 'reviewer' || role === 'verifier') {
        return relation === 'own';
      }
      return false;
    case 'start_member':
    case 'start_replacement':
      if (released) return false;
      if (role === 'planner' && targetRole === 'challenger' && taskKind === 'root') return true;
      if (
        role === 'planner' &&
        targetRole === 'implementer' &&
        taskKind === 'child' &&
        (taskState === 'planned' || taskState === 'implementing') &&
        rootOpen
      ) {
        return true;
      }
      if (
        role === 'implementer' &&
        targetRole === 'reviewer' &&
        relation === 'own' &&
        taskState === 'implementing'
      ) {
        return true;
      }
      if (
        role === 'reviewer' &&
        targetRole === 'verifier' &&
        relation === 'own' &&
        (taskState === 'in_review' || taskState === 'approved' || taskState === 'merging')
      ) {
        return true;
      }
      return false;
    case 'end_self':
      if (role === 'implementer' || role === 'reviewer') return isClosedState(taskState);
      return role === 'planner' || role === 'challenger' || role === 'verifier';
    case 'end_other':
      if (released) return false;
      if (role === 'planner') return input.targetStartedByCaller || input.targetTaskClosed;
      if (role === 'implementer') return input.targetStartedByCaller && input.targetTaskClosed;
      if (role === 'reviewer') return input.targetStartedByCaller;
      return false;
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

function inputOf(fields: {
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
}): PolicyInput {
  return fields;
}

describe('policy table', () => {
  test('names an allow or deny for every role, action, and task state', () => {
    const mismatches: string[] = [];

    for (const role of sessionRoles) {
      for (const action of policyActions) {
        for (const released of [false, true]) {
          for (const taskKind of taskKinds) {
            for (const taskState of taskStates) {
              for (const relation of relations) {
                for (const rootState of taskStates) {
                  for (const targetRole of sessionRoles) {
                    for (const targetStartedByCaller of [false, true]) {
                      for (const targetTaskClosed of [false, true]) {
                        const input = inputOf({
                          role,
                          action,
                          released,
                          taskKind,
                          taskState,
                          relation,
                          rootState,
                          targetRole,
                          targetStartedByCaller,
                          targetTaskClosed,
                        });
                        const decision = evaluatePolicy(input);
                        const allowedByTable = policyRules.some(rule =>
                          matchesPolicyRule(rule, input)
                        );
                        const allowedBySpec = specAllows(input);

                        if (
                          decision.allowed !== allowedByTable ||
                          decision.allowed !== allowedBySpec
                        ) {
                          mismatches.push(
                            `${action} ${role} released=${released} ${taskKind} ${taskState} ${relation} root=${rootState} target=${targetRole} started=${targetStartedByCaller} targetClosed=${targetTaskClosed} evaluator=${decision.allowed} table=${allowedByTable} spec=${allowedBySpec}`
                          );
                        }

                        if (
                          !decision.allowed &&
                          (decision.role !== role || decision.action !== action)
                        ) {
                          mismatches.push(
                            `${action} ${role} denial omitted the role or the action`
                          );
                        }

                        if (mismatches.length >= 12) {
                          expect(mismatches).toEqual([]);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
  });

  test('every action has at least one allowing rule in the exported table', () => {
    for (const action of policyActions) {
      expect(policyRules.some(rule => rule.action === action)).toBe(true);
    }
  });
});
