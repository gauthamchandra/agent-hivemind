import { describe, expect, test } from 'bun:test';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const biome = fileURLToPath(new URL('../../node_modules/.bin/biome', import.meta.url));

const forbiddenImport = new URL('../core/forbidden-import.fixture.ts', import.meta.url);
const platformName = new URL('../core/platform-name.fixture.ts', import.meta.url);
const groupTitle = new URL('../storage/postgres/group-title.fixture.ts', import.meta.url);
const downMigration = new URL('../storage/postgres/down-migration.fixture.ts', import.meta.url);
const forwardMigration = new URL(
  '../storage/postgres/forward-migration.fixture.ts',
  import.meta.url
);

async function check(path: URL): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn([biome, 'check', '--error-on-warnings', fileURLToPath(path)], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
  const code = await proc.exited;

  return { code, output };
}

describe('biome layer rules', () => {
  test('a multiline forbidden import and a platform name fail, and a group title does not', async () => {
    await Bun.write(
      forbiddenImport,
      `import {\n  start,\n} from '@/platform/devin.ts';\n\nexport const session = start;\n`
    );
    await Bun.write(
      platformName,
      `export const platform = 'devin';\nexport const title = 'Cursor refactor';\n`
    );
    await Bun.write(
      groupTitle,
      `export const platform = 'devin';\nexport const title = 'Cursor refactor';\n`
    );

    try {
      const imported = await check(forbiddenImport);
      const named = await check(platformName);
      const title = await check(groupTitle);

      expect(imported.code).not.toBe(0);
      expect(imported.output).toContain('noRestrictedImports');
      expect(named.code).not.toBe(0);
      expect(named.output).toContain('src/core must not name a platform.');
      expect(named.output.match(/must not name a platform/g)?.length).toBe(1);
      expect(title.code).toBe(0);
      expect(title.output).not.toContain('must not name a platform');
      expect(title.output).not.toContain('noRestrictedImports');
    } finally {
      await Promise.all([
        unlink(forbiddenImport).catch(() => undefined),
        unlink(platformName).catch(() => undefined),
        unlink(groupTitle).catch(() => undefined),
      ]);
    }
  });

  test('a down or rollback call fails, and an up call does not', async () => {
    await Bun.write(
      downMigration,
      `export async function undo(migrator: {
  down(options?: { to?: 0 }): Promise<void>;
  rollback(): Promise<void>;
}): Promise<void> {
  await migrator.down();
  await migrator.rollback();
}
`
    );
    await Bun.write(
      forwardMigration,
      `export async function apply(migrator: { up(): Promise<void> }): Promise<void> {
  await migrator.up();
}
`
    );

    try {
      const reversed = await check(downMigration);
      const forward = await check(forwardMigration);

      expect(reversed.code).not.toBe(0);
      expect(reversed.output.match(/Migrations are forward only/g)?.length).toBe(2);
      expect(forward.code).toBe(0);
      expect(forward.output).not.toContain('Migrations are forward only');
    } finally {
      await Promise.all([
        unlink(downMigration).catch(() => undefined),
        unlink(forwardMigration).catch(() => undefined),
      ]);
    }
  });
});
