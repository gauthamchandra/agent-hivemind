import type { SessionId } from '@/domain/ids.ts';
import type { Group, SessionRole, Task } from '@/domain/model.ts';

const standingRules = [
  'Coordinate only through the service, with the command-line tool. If the service cannot be reached after the tool retries, stop and say so in your own platform session, where the owner can see it. Do not start platform sessions yourself, and do not coordinate with members by any other channel.',
  'Only the reviewer of a task marks its pull request as ready for review, and only when it approves the task. No other session changes whether a pull request is a draft. No session reverses such a change. A person can mark a pull request ready early: leave it ready and continue the work.',
  'Each delivered message starts with a header that names the sender role, session and task. Do not start a message body with a role or an identifier. Start with the substance.',
  'If a person gives you an instruction directly, relay what changed, and what it means for your task, to the session that started you. That session forwards it to the members that it affects.',
  'When you ask a member a question, expect an answer within five minutes, and accept a partial answer.',
  'Do not end your session while your task is open and you own a pull request. Release instead.',
].join('\n');

/**
 * Compose the prompt a new session receives. The session token is never included.
 * An enrollment code is included only when the connection cannot inject a secret.
 */
export function composePrompt(input: {
  role: SessionRole;
  sessionId: SessionId;
  group: Group;
  task: Task;
  parentSessionId: SessionId | null;
  instructions: string;
  enrollmentCode: string | null;
  replacement: boolean;
}): string {
  const enrollment =
    input.enrollmentCode === null
      ? 'A secret named HIVEMIND_TOKEN is already in the environment. Do not print it.'
      : `Enrollment code: ${input.enrollmentCode}\nRun hivemind enroll --session ${input.sessionId} --code ${input.enrollmentCode}, then do not print the token.`;
  const replacement = input.replacement
    ? 'You are a replacement. Read the task history before you change anything.'
    : '';
  const verifier =
    input.role === 'verifier'
      ? 'When the task changes access rules or deployment configuration, read the live configuration again immediately before you report that verification is complete. Do not rely only on merged pull requests. If the live configuration differs from the intended state, stop and report the difference.'
      : '';

  const changeset =
    input.role === 'implementer' || input.role === 'reviewer' || input.role === 'verifier'
      ? `Changeset: ${input.task.changeset_id ?? 'none'}.`
      : '';

  return [
    `You are the ${input.role} of group ${input.group.name} (${input.group.id}).`,
    `Session: ${input.sessionId}.`,
    `Task: ${input.task.id}. ${input.task.title}`,
    input.task.description,
    changeset,
    `Verification: ${input.task.verification_mode}.`,
    `Started by: ${input.parentSessionId ?? 'a person'}.`,
    enrollment,
    standingRules,
    verifier,
    replacement,
    'Instructions from the starter:',
    '--- starter ---',
    input.instructions,
    '--- end starter ---',
    `Goal: ${input.group.goal}`,
  ]
    .filter(part => part.length > 0)
    .join('\n\n');
}
