import { openInstallation } from '@/core/installation.ts';
import { startHttp } from '@/http/server.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import { requirePresent } from '@/testing/assertions.ts';
import { createTestDeps } from '@/testing/deps.ts';
import { openMigratedDatabase } from '@/testing/pglite.ts';
import { createTestPlatforms } from '@/testing/platforms.ts';
import { runAfterTest } from '@/testing/teardown.ts';

type BootOptions = { secretInjection?: boolean };

/**
 * Boot the service on a migrated database and the simulated platform, with no HTTP server.
 *
 * <p>Pass {@code secretInjection: false} to make the platform refuse to inject secrets, which
 * is how a session learns to enroll with a code.
 */
export async function bootService(options?: BootOptions) {
  const db = await openMigratedDatabase();
  const deps = createTestDeps(db);
  const connectionId = deps.ids.connection();
  const simulated = createSimulatedPlatform(connectionId);

  if (options?.secretInjection === false) simulated.drop('secret_injection');

  const platforms = createTestPlatforms(connectionId, simulated);

  return { db, deps, platforms, connectionId, simulated };
}

/** Boot the service and serve it over HTTP. The server stops after the test. */
export async function bootHttpService(options?: BootOptions) {
  const service = await bootService(options);
  const installation = await openInstallation(service.deps);
  const server = await startHttp({
    deps: service.deps,
    platforms: service.platforms,
    connectionId: service.connectionId,
  });

  runAfterTest(() => server.stop());

  return {
    ...service,
    server,
    bootstrap: requirePresent(
      installation.bootstrapSecret,
      'the empty store should print a bootstrap key'
    ),
  };
}

export type Service = Awaited<ReturnType<typeof bootService>>;
export type HttpService = Awaited<ReturnType<typeof bootHttpService>>;
