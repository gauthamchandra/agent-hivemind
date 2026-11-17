const pendingTeardowns: (() => unknown)[] = [];

/**
 * Register work to run after the current test, whether the test passed or failed.
 *
 * <p>Teardowns run in reverse order of registration, so a server registered after its database
 * stops before that database closes. The test preload runs {@link runPendingTeardowns}.
 */
export function runAfterTest(teardown: () => unknown): void {
  pendingTeardowns.push(teardown);
}

/**
 * Run every registered teardown, then report all failures together.
 *
 * <p>One rejecting teardown must not stop the rest. The list is emptied before the loop, so a
 * skipped teardown would never run again and its server, database, or directory would leak.
 */
export async function runPendingTeardowns(): Promise<void> {
  const teardowns = pendingTeardowns.splice(0).reverse();
  const failures: unknown[] = [];

  for (const teardown of teardowns) {
    try {
      await teardown();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) throw new AggregateError(failures, 'Test teardown failed.');
}
