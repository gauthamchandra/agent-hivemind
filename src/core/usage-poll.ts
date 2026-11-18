import { syncAlerts } from '@/core/alert-sync.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { type JobRunResult, type RunOptions, takeJob } from '@/core/job-run.ts';
import { StoppedProcess } from '@/core/session-types.ts';
import { finishPollsOfGoneSessions, pollSession } from '@/core/usage-poll-result.ts';
import type { JobSnapshot } from '@/domain/background-jobs.ts';
import {
  recordsPerWorkspace,
  usagePollDeadlineMs,
  usagePollIntervalMs,
} from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import type { SessionRecord } from '@/domain/model.ts';
import type { Platforms } from '@/ports/platform.ts';

export async function runUsagePoll(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<JobRunResult> {
  const lockId = await takeJob(deps, 'usage_poll', options.workerId, usagePollIntervalMs);

  if (lockId === null) return { ran: false, lockId: null };

  const started = deps.clock.now().getTime();
  const snapshot = await deps.store.transact(tx => tx.loadJobSnapshot());
  const ordered = batch(snapshot);
  const unreliable = new Set<string>();
  const grew = new Set<string>();

  await finishPollsOfGoneSessions(deps, snapshot, lockId);

  for (const session of ordered) {
    if (deps.clock.now().getTime() - started > usagePollDeadlineMs) break;

    try {
      if (await pollSession(deps, platforms, snapshot, session, lockId, options, unreliable)) {
        grew.add(session.task_id);
      }
    } catch (error) {
      if (error instanceof StoppedProcess) throw error;
      if (error instanceof HivemindError && error.code === 'conflict') throw error;

      console.error(`Usage poll skipped session ${session.id}.`, error);
    }
  }

  // A read can take minutes, so the alerts are judged from what the run committed, not from the
  // snapshot it started with.
  const committed = await deps.store.transact(tx => tx.loadJobSnapshot());

  await syncAlerts(deps, platforms, committed, lockId, {
    unreliableConnections: unreliable,
    tasksWithUsageGrowth: grew,
  });

  return { ran: true, lockId };
}

/**
 * Order the sessions to poll. A session has waited since its last attempt, or since it was created
 * if it was never attempted. Each workspace's sessions go longest-waiting first, capped at
 * `recordsPerWorkspace`. The workspaces are then interleaved, the one with the longest wait first,
 * so a run that ends at its deadline starts the next run with the workspaces it missed, and a
 * workspace that keeps gaining new sessions cannot keep an older one from being read.
 */
function batch(snapshot: JobSnapshot): SessionRecord[] {
  const lastAttemptAt = new Map(
    snapshot.sessionJobStates.map(jobState => [jobState.sessionId, jobState.lastAttemptAt])
  );
  const attemptOf = (session: SessionRecord) =>
    Date.parse(lastAttemptAt.get(session.id) ?? session.created_at);
  const byWorkspace = new Map<string, SessionRecord[]>();

  for (const session of snapshot.sessions) {
    if (session.platform_session_ref === null) continue;

    const list = byWorkspace.get(session.workspace_id) ?? [];

    list.push(session);
    byWorkspace.set(session.workspace_id, list);
  }

  const lists = [...byWorkspace.values()]
    .map(list => list.sort((left, right) => attemptOf(left) - attemptOf(right)))
    .map(list => list.slice(0, recordsPerWorkspace))
    .sort((left, right) => oldestAttempt(left, attemptOf) - oldestAttempt(right, attemptOf));
  const ordered: SessionRecord[] = [];

  for (let index = 0; lists.some(list => index < list.length); index += 1) {
    for (const list of lists) {
      const session = list[index];

      if (session !== undefined) ordered.push(session);
    }
  }

  return ordered;
}

function oldestAttempt(
  sortedList: SessionRecord[],
  attemptOf: (session: SessionRecord) => number
): number {
  const oldest = sortedList[0];

  return oldest === undefined ? 0 : attemptOf(oldest);
}
