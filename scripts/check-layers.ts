import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');

const layers = [
  'storage',
  'platform',
  'domain',
  'policy',
  'ports',
  'core',
  'notify',
  'identity',
  'http',
  'console',
  'cli',
  'conformance',
] as const;

type Layer = (typeof layers)[number] | 'main';

const allowed: Record<Layer, readonly string[]> = {
  domain: [],
  policy: ['domain'],
  ports: ['domain'],
  core: ['domain', 'policy', 'ports'],
  storage: ['domain', 'ports'],
  platform: ['domain', 'ports'],
  notify: ['domain', 'ports'],
  identity: ['domain', 'ports'],
  http: ['domain', 'core', 'ports'],
  console: [],
  cli: ['domain'],
  conformance: ['domain', 'ports'],
  main: [
    'domain',
    'policy',
    'ports',
    'core',
    'storage',
    'platform',
    'notify',
    'identity',
    'http',
    'console',
    'cli',
    'conformance',
  ],
};

const platformName = /\b(devin|cursor|simulated)\b/i;
const importFrom = /(?:import|export)\s+(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
const importCall = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

const failures: string[] = [];

for (const file of await sourceFiles(source)) {
  const relative = path.relative(root, file).split(path.sep).join('/');
  const text = await readFile(file, 'utf8');
  const layer = layerOf(relative);

  if (relative.startsWith('src/core/') && platformName.test(text)) {
    failures.push(`${relative} names a platform`);
  }

  if (relative.endsWith('.test.ts')) continue;

  if (layer === null) {
    failures.push(`${relative} is not in a known layer`);
    continue;
  }

  for (const specifier of specifiers(text)) {
    const imported = resolveImport(file, specifier);

    if (imported === null) continue;

    const importedLayer = layerOf(imported);

    if (importedLayer === null) {
      failures.push(`${relative} imports ${imported}, which is not in a known layer`);
      continue;
    }

    if (importedLayer === layer) continue;

    const permit = allowed[layer];

    if (!permit.includes(importedLayer)) {
      failures.push(`${relative} (${layer}) imports ${imported} (${importedLayer})`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}

function layerOf(relative: string): Layer | null {
  if (relative === 'src/index.ts') return 'main';
  if (relative.startsWith('src/storage/postgres/')) return 'storage';

  for (const layer of layers) {
    if (layer === 'storage') continue;
    if (relative.startsWith(`src/${layer}/`)) return layer;
  }

  return null;
}

function specifiers(text: string): string[] {
  const found: string[] = [];

  for (const pattern of [importFrom, importCall]) {
    pattern.lastIndex = 0;

    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];

      if (specifier !== undefined) found.push(specifier);
    }
  }

  return found;
}

function resolveImport(file: string, specifier: string): string | null {
  if (specifier.startsWith('@/')) {
    return `src/${specifier.slice(2)}`;
  }

  if (!specifier.startsWith('.')) return null;

  const resolved = path.relative(root, path.resolve(path.dirname(file), specifier));

  return resolved.split(path.sep).join('/');
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
      continue;
    }

    if (entry.name.endsWith('.ts')) files.push(full);
  }

  return files;
}
