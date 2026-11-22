import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function readRepoFile(path: string): Promise<string> {
  return readFile(`${root}${path}`, 'utf8');
}

test('a push to main asks the shared releaser app for the release pull request', async () => {
  const workflow = await readRepoFile('.github/workflows/release.yml');
  const actionRefs = [...workflow.matchAll(/uses: \S+@(\S+)/g)].flatMap(match => {
    const ref = match[1];
    return ref == null ? [] : [ref];
  });

  expect(workflow).toContain('branches: [main]');
  expect(workflow).toContain('secrets.RELEASE_APP_ID');
  expect(workflow).toContain('secrets.RELEASE_APP_PRIVATE_KEY');
  expect(workflow).toContain('actions/create-github-app-token@');
  expect(workflow).toContain('googleapis/release-please-action@');
  expect(workflow).toContain(`token: \${{ steps.app-token.outputs.token }}`);
  expect(actionRefs).toHaveLength(2);
  expect(actionRefs.every(ref => /^[0-9a-f]{40}$/.test(ref))).toBe(true);
  expect(workflow.toLowerCase()).not.toContain('fly');
});

test('release-please versions this package from the manifest and writes a changelog', async () => {
  const manifest = JSON.parse(await readRepoFile('.release-please-manifest.json')) as {
    '.': string;
  };
  const pkg = JSON.parse(await readRepoFile('package.json')) as { version: string };
  const config = JSON.parse(await readRepoFile('release-please-config.json')) as {
    'release-type': string;
    'pull-request-title-pattern': string;
    'include-v-in-tag': boolean;
    'changelog-sections': { type: string; section: string }[];
  };
  const changelog = await readRepoFile('CHANGELOG.md');

  expect(manifest['.']).toBe(pkg.version);
  expect(config['release-type']).toBe('node');
  const versionPlaceholder = '$' + '{version}';

  expect(config['pull-request-title-pattern']).toBe(`chore: release ${versionPlaceholder}`);
  expect(config['include-v-in-tag']).toBe(true);
  expect(config['changelog-sections']).toContainEqual({ type: 'feat', section: 'Features' });
  expect(config['changelog-sections']).toContainEqual({ type: 'fix', section: 'Bug Fixes' });
  expect(changelog.startsWith('# Changelog\n')).toBe(true);
});
