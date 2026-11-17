import { HivemindError } from '@/domain/errors.ts';
import type { ConnectionId } from '@/domain/ids.ts';
import type { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import type { PlatformAdapter, Platforms } from '@/ports/platform.ts';

export type SimulatedPlatform = ReturnType<typeof createSimulatedPlatform>;

type PlatformTestContext = {
  platforms: Platforms;
  connectionId: ConnectionId;
  simulated: SimulatedPlatform;
};

/**
 * Serve one connection from the simulated platform and refuse every other connection.
 *
 * <p>Pass an adapter to serve a wrapped version of {@code simulated.adapter}, for example one
 * that holds a call open or fails it on purpose.
 */
export function createTestPlatforms(
  connectionId: ConnectionId,
  simulated: SimulatedPlatform,
  adapter: PlatformAdapter = simulated.adapter
): Platforms {
  return {
    require(id) {
      if (id !== connectionId) {
        throw new HivemindError('not_found', 'No connection with that identifier exists.');
      }

      return { adapter, connection: simulated.connection() };
    },
  };
}

/** Make an already booted service talk to the given adapter from now on. */
export function replaceAdapter(ctx: PlatformTestContext, adapter: PlatformAdapter): void {
  ctx.platforms.require = createTestPlatforms(ctx.connectionId, ctx.simulated, adapter).require;
}

export function promptMentioning(simulated: SimulatedPlatform, sessionId: string): string {
  const prompt = simulated.prompts().find(text => text.includes(sessionId));

  if (prompt === undefined) throw new Error(`no prompt mentions ${sessionId}`);

  return prompt;
}

export function enrollmentCodeIn(prompt: string): string {
  const code = /Enrollment code: (enr_[A-Za-z0-9_-]+)/.exec(prompt)?.[1];

  if (code === undefined) throw new Error('the prompt should carry an enrollment code');

  return code;
}
