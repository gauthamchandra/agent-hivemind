import type { ServiceDeps } from '@/core/deps.ts';
import { runFleetCheck } from '@/core/fleet-check.ts';
import { runHousekeeping } from '@/core/housekeeping.ts';
import { runReaper } from '@/core/reaper.ts';
import type { RunOptions, TickResult } from '@/core/supervision-run.ts';
import type { Notifier } from '@/ports/notifier.ts';
import type { Platforms } from '@/ports/platform.ts';

export { escalateSession } from '@/core/escalate.ts';
export { commitObservation, runFleetCheck } from '@/core/fleet-check.ts';
export { runHousekeeping } from '@/core/housekeeping.ts';
export { runReaper } from '@/core/reaper.ts';
export type { RunOptions, TickResult } from '@/core/supervision-run.ts';
export { SupervisionHalted } from '@/core/supervision-run.ts';

/** Run whichever of the three jobs is due. The lease row decides if this worker does the work. */
export async function runDueJobs(
  deps: ServiceDeps,
  platforms: Platforms,
  notifier: Notifier | null,
  options: RunOptions
): Promise<TickResult[]> {
  return [
    await runFleetCheck(deps, platforms, notifier, options),
    await runReaper(deps, platforms, options),
    await runHousekeeping(deps, platforms, options),
  ];
}
