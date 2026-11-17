import { expect, test } from 'bun:test';
import { runAdapterConformance } from '@/conformance/suite.ts';
import { createIds } from '@/domain/ids.ts';
import { createSimulatedPlatform } from '@/platform/simulated/adapter.ts';
import { manualClock } from '@/ports/clock.ts';
import type { StartSessionInput } from '@/ports/platform.ts';
import { systemRandom } from '@/ports/random.ts';

test('the simulated adapter passes the eleven conformance cases', async () => {
  const ids = createIds(manualClock(new Date('2026-11-16T00:00:00.000Z')), systemRandom);
  const simulated = createSimulatedPlatform(ids.connection());
  const report = await runAdapterConformance(
    simulated.adapter,
    simulated.connection(),
    simulated.controls
  );

  expect(report.cases.map(item => item.name)).toEqual([
    'probe',
    'idempotent_start',
    'status_mapping',
    'send_results',
    'end_repeat',
    'error_classes',
    'secrets_stay_out_of_errors',
    'usage_never_decreases',
    'send_after_end',
    'find_by_key',
    'start_timeout',
  ]);
  expect(report.cases.filter(item => !item.passed).map(item => item.detail)).toEqual([]);
});

test('a start or send error that includes a marker fails the secrets case', async () => {
  const ids = createIds(manualClock(new Date('2026-11-16T00:00:00.000Z')), systemRandom);
  const simulated = createSimulatedPlatform(ids.connection());
  const adapter = {
    ...simulated.adapter,
    async start(
      connection: Parameters<typeof simulated.adapter.start>[0],
      input: Parameters<typeof simulated.adapter.start>[1]
    ) {
      try {
        return await simulated.adapter.start(connection, input);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';

        throw new Error(`${message} ${input.prompt}`);
      }
    },
    async send(
      connection: Parameters<typeof simulated.adapter.send>[0],
      ref: string,
      body: string
    ) {
      try {
        return await simulated.adapter.send(connection, ref, body);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';

        throw new Error(`${message} ${body}`);
      }
    },
  };
  const report = await runAdapterConformance(adapter, simulated.connection(), simulated.controls);
  const secrets = report.cases.find(item => item.name === 'secrets_stay_out_of_errors');

  expect(secrets?.passed).toBe(false);
});

test('an ended session reads as stopped', async () => {
  const ids = createIds(manualClock(new Date('2026-11-16T00:00:00.000Z')), systemRandom);
  const simulated = createSimulatedPlatform(ids.connection());
  const started = await simulated.adapter.start(simulated.connection(), platformStart('ses_ended'));

  await simulated.adapter.end(simulated.connection(), started.platformSessionRef);

  const status = await simulated.adapter.readStatus(
    simulated.connection(),
    started.platformSessionRef
  );
  const many = await simulated.adapter.readMany(simulated.connection(), [
    started.platformSessionRef,
  ]);

  expect(status.status).toBe('stopped');
  expect(many[0]?.status).toBe('stopped');
});

test('a new process does not reuse a platform reference from the last one', async () => {
  const ids = createIds(manualClock(new Date('2026-11-16T00:00:00.000Z')), systemRandom);
  const connectionId = ids.connection();
  const first = createSimulatedPlatform(connectionId);
  const started = await first.adapter.start(first.connection(), platformStart('ses_saved'));
  const restarted = createSimulatedPlatform(connectionId);
  const next = await restarted.adapter.start(restarted.connection(), platformStart('ses_next'));

  expect(next.platformSessionRef).not.toBe(started.platformSessionRef);

  await restarted.adapter.end(restarted.connection(), started.platformSessionRef);

  const status = await restarted.adapter.readStatus(
    restarted.connection(),
    next.platformSessionRef
  );

  expect(status.status).toBe('working');
});

function platformStart(key: string): StartSessionInput {
  return {
    prompt: 'Plan the work.',
    title: 'Checkout - Planner 1',
    idempotencyKey: key,
    settings: { model_tier: null, repositories: [], platform_settings: {}, role_tiers: {} },
    secret: null,
    onBehalfOf: null,
    usageCeiling: null,
    tags: { workspaceId: 'ws_default', groupId: 'grp', sessionId: key, role: 'planner' },
  };
}
