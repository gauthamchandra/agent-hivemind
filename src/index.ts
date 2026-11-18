import { PGlite } from '@electric-sql/pglite';
import { runDueJobs } from '@/core/background-jobs.ts';
import { drainOutbox } from '@/core/delivery.ts';
import type { ServiceDeps } from '@/core/deps.ts';
import { openInstallation } from '@/core/installation.ts';
import { createWorkerId } from '@/core/job-run.ts';
import { jobLockCheckMs } from '@/domain/background-jobs.ts';
import { HivemindError } from '@/domain/errors.ts';
import { type ConnectionId, createIds, defaultWorkspaceId } from '@/domain/ids.ts';
import { formatTime } from '@/domain/time.ts';
import { startHttp } from '@/http/server.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import { systemClock } from '@/ports/clock.ts';
import type { Platforms } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';
import { openPgliteStore } from '@/storage/postgres/store.ts';

/**
 * Start hivemind-svc. A directory keeps the PGlite record. `dataDir: null` keeps it in memory.
 */
export async function startHivemind(options?: {
  port?: number;
  dataDir?: string | null;
  responseKey?: string;
}): Promise<{
  url: string;
  port: number;
  bootstrapSecret: string | null;
  stop: () => Promise<void>;
}> {
  const dataDir = options?.dataDir === undefined ? '.hivemind' : options.dataDir;
  const database = dataDir === null ? new PGlite() : new PGlite(dataDir);
  const store = openPgliteStore(database);
  const deps: ServiceDeps = {
    store,
    clock: systemClock,
    random: systemRandom,
    ids: createIds(systemClock, systemRandom),
    responseKey: configuredResponseKey(options?.responseKey),
  };

  await store.migrate();

  const installation = await openInstallation(deps);
  const connectionId = await ensureConnection(deps);
  const simulated = createSimulatedPlatform(connectionId, { recordSent: false });
  const platforms: Platforms = {
    require(id) {
      if (id !== connectionId) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter: simulated.adapter, connection: simulated.connection() };
    },
  };
  const server = await startHttp({
    deps,
    platforms,
    connectionId,
    ...(options?.port === undefined ? {} : { port: options.port }),
  });
  const workerId = createWorkerId(systemRandom.bytes(8));
  let draining = false;
  let backgroundJobsRunning = false;
  let activeDrain: Promise<void> = Promise.resolve();
  let activeBackgroundJobs: Promise<void> = Promise.resolve();
  const runBackgroundJobs = () => {
    if (backgroundJobsRunning) return;

    backgroundJobsRunning = true;
    activeBackgroundJobs = runDueJobs(deps, platforms, { workerId })
      .then(() => undefined)
      .catch(error => {
        console.error('Background jobs failed. Each job runs again after its interval.', error);
      })
      .finally(() => {
        backgroundJobsRunning = false;
      });
  };
  const timer = setInterval(() => {
    if (!draining) {
      draining = true;
      activeDrain = drainOutbox(deps, platforms, { workerId })
        .catch(() => {
          console.error('Delivery will retry on the next tick.');
        })
        .finally(() => {
          draining = false;
        });
    }
  }, 1000);
  const backgroundJobsTimer = setInterval(runBackgroundJobs, jobLockCheckMs);

  runBackgroundJobs();

  return {
    url: server.url,
    port: server.port,
    bootstrapSecret: installation.bootstrapSecret,
    async stop() {
      clearInterval(timer);
      clearInterval(backgroundJobsTimer);
      await activeDrain;
      await activeBackgroundJobs;
      server.stop();
      await database.close();
    },
  };
}

function configuredResponseKey(given: string | undefined): string {
  const key = given ?? process.env.HIVEMIND_RESPONSE_KEY ?? '';

  if (key.length === 0) {
    throw new HivemindError('unavailable', 'HIVEMIND_RESPONSE_KEY is not set.');
  }

  return key;
}

async function ensureConnection(deps: ServiceDeps): Promise<ConnectionId> {
  const existing = await deps.store.connection(defaultWorkspaceId);

  if (existing !== null) return existing;

  const id = deps.ids.connection();

  try {
    await deps.store.saveConnection({
      workspaceId: defaultWorkspaceId,
      id,
      adapter: 'simulated',
      createdAt: formatTime(deps.clock.now()),
    });

    return id;
  } catch (error) {
    const saved = await deps.store.connection(defaultWorkspaceId);

    if (saved !== null) return saved;

    throw error;
  }
}

if (import.meta.main) {
  const port = process.env.PORT === undefined ? undefined : Number(process.env.PORT);
  const started = await startHivemind({
    ...(port === undefined ? {} : { port }),
    dataDir: process.env.HIVEMIND_DATA ?? '.hivemind',
  });

  if (started.bootstrapSecret) {
    console.log(`Bootstrap key (shown once): ${started.bootstrapSecret}`);
  }

  console.log(`hivemind-svc listening on ${started.url}`);
}
