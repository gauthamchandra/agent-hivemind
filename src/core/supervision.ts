import type { ServiceDeps } from '@/core/deps.ts';
import { runReaper } from '@/core/reaper.ts';
import type { RunOptions, TickResult } from '@/core/supervision-run.ts';
import type { Platforms } from '@/ports/platform.ts';

/** Run whichever job is due. The lease row decides if this worker does the work. */
export async function runDueJobs(
  deps: ServiceDeps,
  platforms: Platforms,
  options: RunOptions
): Promise<TickResult[]> {
  return [await runReaper(deps, platforms, options)];
}
