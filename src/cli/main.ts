import {
  enrollCommand,
  memberCommand,
  releaseCommand,
  taskCommand,
  whoamiCommand,
} from '@/cli/commands.ts';
import { CliError, exitCode, type Io, parseArgs } from '@/cli/io.ts';
import { messageCommand } from '@/cli/message-commands.ts';

const instructions: Record<string, string> = {
  cap_reached: 'Do not retry. Tell the planner which cap was reached, or escalate.',
  policy_denied: 'Your role cannot do this. Ask the member whose role can.',
  unauthenticated: 'Enroll again, or ask for a new enrollment code.',
  token_unreadable: 'The token file cannot be read. Fix that file, or enroll again.',
  session_not_active: 'This session cannot do that from its current life.',
  invalid_transition:
    'Read the task and report a transition your role can make from its current state.',
  evidence_required: 'Add the evidence this transition asks for, then report it again.',
  conflict: 'Read the task again and report with the current version.',
  start_pending: 'The start is still pending. Read the session before you try again.',
  rate_limited: 'Wait, then try again. Do not send the same message in a loop.',
  recipient_not_available: 'That member cannot receive a message. Pick a live member.',
};

export async function runHivemind(io: Io): Promise<number> {
  try {
    const parsed = parseArgs(io.args);
    const enrolled = await enrollCommand(io, parsed);

    if (enrolled !== null) return enrolled;

    const who = await whoamiCommand(io, parsed);

    if (who !== null) return who;

    const task = await taskCommand(io, parsed);

    if (task !== null) return task;

    const member = await memberCommand(io, parsed);

    if (member !== null) return member;

    const released = await releaseCommand(io, parsed);

    if (released !== null) return released;

    const message = await messageCommand(io, parsed);

    if (message !== null) return message;
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(error.code);
      io.stderr(error.message);
      io.stderr(
        instructions[error.code] ?? 'Stop and say what failed in your own platform session.'
      );

      return exitCode(error.code);
    }

    io.stderr('unavailable');
    io.stderr(error instanceof Error ? error.message : 'The service cannot be reached.');
    io.stderr('Stop. Say in your own platform session that the service cannot be reached.');

    return 11;
  }
  io.stderr(
    'Run hivemind enroll, whoami, task, member, release, resume, send, ask, answer, relay, inbox, or escalate.'
  );

  return 12;
}

if (import.meta.main) {
  const code = await runHivemind({
    args: process.argv.slice(2),
    env: process.env,
    stdout: line => console.log(line),
    stderr: line => console.error(line),
    fetch,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  });

  process.exit(code);
}
