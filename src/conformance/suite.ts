import { check, sameList, startInput } from '@/conformance/suite-check.ts';
import {
  PlatformError,
  type PlatformErrorClass,
  platformErrorClasses,
  type SendResult,
} from '@/domain/platform.ts';
import type { ConformanceControls } from '@/ports/conformance.ts';
import type { PlatformAdapter, PlatformConnection } from '@/ports/platform.ts';

export type ConformanceCase = { name: string; passed: boolean; detail: string };

/**
 * Run the eleven adapter cases. The controls stand in for a recorded platform:
 * the suite never opens a network connection.
 */
export async function runAdapterConformance(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<{ cases: ConformanceCase[] }> {
  const cases: ConformanceCase[] = [];

  for (const item of [
    ['probe', () => probe(adapter, connection, controls)],
    ['idempotent_start', () => idempotentStart(adapter, connection, controls)],
    ['status_mapping', () => statusMapping(adapter, connection, controls)],
    ['send_results', () => sendResults(adapter, connection, controls)],
    ['end_repeat', () => endRepeat(adapter, connection)],
    ['error_classes', () => errorClasses(adapter, connection, controls)],
    ['secrets_stay_out_of_errors', () => secrets(adapter, connection, controls)],
    ['usage_never_decreases', () => usage(adapter, connection, controls)],
    ['send_after_end', () => sendAfterEnd(adapter, connection, controls)],
    ['find_by_key', () => findByKey(adapter, connection, controls)],
    ['start_timeout', () => startTimeout(adapter, connection, controls)],
  ] as const) {
    try {
      await item[1]();
      cases.push({ name: item[0], passed: true, detail: '' });
    } catch (error) {
      cases.push({
        name: item[0],
        passed: false,
        detail: error instanceof Error ? error.message : 'The case failed.',
      });
    }
  }

  return { cases };
}

async function probe(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const result = await adapter.probe(connection);

  check(
    sameList(result.capabilities, controls.documentedCapabilities),
    'Probe did not return the documented capabilities.'
  );
}

async function idempotentStart(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const first = await adapter.start(connection, startInput('idem-1', 'a prompt'));
  const before = controls.calls().filter(call => call === 'start').length;
  const second = await adapter.start(connection, startInput('idem-1', 'a prompt'));

  check(
    first.platformSessionRef === second.platformSessionRef,
    'A repeated key created another session.'
  );
  check(
    controls.calls().filter(call => call === 'start').length === before + 1,
    'The second start was not attempted.'
  );
}

async function statusMapping(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('status-1', 'status prompt'));

  for (const row of controls.documentedStatuses) {
    controls.setPlatformStatus(row.platform);
    const status = await adapter.readStatus(connection, started.platformSessionRef);

    check(status.status === row.neutral, `${row.platform} mapped to ${status.status}.`);
  }

  controls.setPlatformStatus(controls.unrecognizedStatus);
  const unknown = await adapter.readStatus(connection, started.platformSessionRef);

  check(unknown.status === 'working', 'An unrecognized status did not map to working.');
}

async function sendResults(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('send-1', 'send prompt'));
  const expected: SendResult[] = ['accepted', 'busy', 'rate_limited', 'gone'];

  for (const result of expected) {
    controls.setSendResult(result);
    const actual = await adapter.send(connection, started.platformSessionRef, 'hello');

    check(actual === result, `Send returned ${actual} for ${result}.`);
  }
}

async function endRepeat(adapter: PlatformAdapter, connection: PlatformConnection): Promise<void> {
  const started = await adapter.start(connection, startInput('end-1', 'end prompt'));

  await adapter.end(connection, started.platformSessionRef);
  await adapter.end(connection, started.platformSessionRef);
}

async function errorClasses(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('err-1', 'error prompt'));

  for (const errorClass of platformErrorClasses) {
    controls.queueError('readStatus', errorClass);

    try {
      await adapter.readStatus(connection, started.platformSessionRef);
      check(false, `${errorClass} did not fail the read.`);
    } catch (error) {
      check(
        error instanceof PlatformError && error.errorClass === errorClass,
        `${errorClass} was mapped wrong.`
      );
    }
  }
}

async function secrets(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const errors: string[] = [];

  controls.queueError('start', 'invalid');

  try {
    await adapter.start(connection, startInput('secret-fail', `prompt ${controls.promptMarker}`));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '');
  }

  const started = await adapter.start(
    connection,
    startInput('secret-1', `prompt ${controls.promptMarker}`)
  );

  controls.queueError('send', 'invalid');

  try {
    await adapter.send(connection, started.platformSessionRef, controls.messageMarker);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '');
  }

  controls.queueError('readUsage', 'invalid');

  try {
    await adapter.readUsage(connection, 'missing');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : '');
  }

  const text = errors.join('\n');

  const logs = controls.logs().join('\n');
  const hidden = [controls.credential, controls.promptMarker, controls.messageMarker];

  check(
    hidden.every(marker => !text.includes(marker) && !logs.includes(marker)),
    'An error or a log contains a credential, a prompt, or a message body.'
  );
}

async function usage(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('usage-1', 'usage prompt'));

  controls.setReportedUsage(5);

  const first = await adapter.readUsage(connection, started.platformSessionRef);

  controls.setReportedUsage(2);

  const second = await adapter.readUsage(connection, started.platformSessionRef);

  check(first === 5 && second === 5, 'A later usage reading was smaller than an earlier one.');
  check(
    controls.logs().some(line => line.includes('went backwards')),
    'A backwards usage reading was not logged.'
  );
}

async function sendAfterEnd(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('gone-1', 'gone prompt'));

  await adapter.end(connection, started.platformSessionRef);

  const mark = controls.calls().length;
  const result = await adapter.send(connection, started.platformSessionRef, controls.messageMarker);
  const later = controls.calls().slice(mark);

  check(result === 'gone', 'A send after end did not return gone.');
  check(
    later.every(call => call !== 'start' && call !== 'wake' && call !== 'unarchive'),
    'A send after end made a call that can restart the session.'
  );
}

async function findByKey(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  const started = await adapter.start(connection, startInput('find-1', 'find prompt'));
  const found = await adapter.findByKey(connection, 'find-1', '2026-11-16T00:00:00.000Z');
  const missing = await adapter.findByKey(connection, 'find-missing', '2026-11-16T00:00:00.000Z');

  check(
    found.outcome === 'found' && found.platformSessionRef === started.platformSessionRef,
    'Find did not return the session a start created.'
  );
  check(missing.outcome === 'absent', 'Find did not answer absent for a key no start used.');

  controls.loseNextStartResponse();

  let lost = false;

  try {
    await adapter.start(connection, startInput('find-lost', 'lost prompt'));
  } catch (error) {
    lost = error instanceof PlatformError && error.errorClass === 'unavailable';
  }

  const recovered = await adapter.findByKey(connection, 'find-lost', '2026-11-16T00:00:00.000Z');

  check(lost, 'A lost start response was not unavailable.');
  check(recovered.outcome === 'found', 'Find missed a session whose start response was lost.');
}

async function startTimeout(
  adapter: PlatformAdapter,
  connection: PlatformConnection,
  controls: ConformanceControls
): Promise<void> {
  controls.queueError('start', 'unavailable');

  try {
    await adapter.start(connection, startInput('timeout-1', 'timeout prompt'));
    check(false, 'A timed-out start returned a session.');
  } catch (error) {
    const refusal: PlatformErrorClass[] = ['auth', 'invalid', 'quota', 'rate_limited'];

    check(
      error instanceof PlatformError &&
        error.errorClass === 'unavailable' &&
        !refusal.includes(error.errorClass),
      'A timed-out start was reported as a refusal.'
    );
  }
}
