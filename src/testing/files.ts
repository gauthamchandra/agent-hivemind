import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAfterTest } from '@/testing/teardown.ts';

/** Create an empty directory under the system temp folder and delete it after the test. */
export async function createTemporaryDirectory(prefix = 'hivemind-'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));

  runAfterTest(() => rm(directory, { recursive: true, force: true }));

  return directory;
}
