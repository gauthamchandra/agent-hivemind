import type { ServiceDeps } from '@/core/deps.ts';
import { runHousekeeping } from '@/core/housekeeping.ts';
import type { JobRunResult, RunOptions } from '@/core/job-run.ts';
import { runReaper } from '@/core/reaper.ts';
import { runUsagePoll } from '@/core/usage-poll.ts';
import type { Platforms } from '@/ports/platform.ts';

/**
 * Run whichever job is due. The job lock decides if this worker does the work.
 *
 * <p>The jobs run side by side, so a job that is slow or fails does not hold up the other. Every
 * job gets its turn before a failure is reported.
 */
export async function runDueJobs(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<JobRunResult[]> {
  const runs = await Promise.allSettled([
    runUsagePoll(deps, platforms, options),
    runReaper(deps, platforms, options),
    runHousekeeping(deps, options),
  ]);
  const failures = runs.flatMap(run => (run.status === 'rejected' ? [run.reason] : []));

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, 'More than one background job failed.');

  return runs.flatMap(run => (run.status === 'fulfilled' ? [run.value] : []));
}
