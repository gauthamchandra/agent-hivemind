import type { ServiceDeps } from '@/core/deps.ts';
import type { JobRunResult, RunOptions } from '@/core/job-run.ts';
import { runReaper } from '@/core/reaper.ts';
import type { Platforms } from '@/ports/platform.ts';

/** Run whichever job is due. The job lock decides if this worker does the work. */
export async function runDueJobs(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<JobRunResult[]> {
  return [await runReaper(deps, platforms, options)];
}
