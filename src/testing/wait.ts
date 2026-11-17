/**
 * Poll until the lookup returns a value, then return it.
 *
 * <p>The failure names what the test waited for. Polls every 10ms, 50 times by default.
 */
export async function waitUntil<T>(
  find: () => T | null | undefined | Promise<T | null | undefined>,
  description: string,
  options?: { attempts?: number }
): Promise<T> {
  const attempts = options?.attempts ?? 50;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const found = await find();

    if (found !== null && found !== undefined) return found;

    await Bun.sleep(10);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}
