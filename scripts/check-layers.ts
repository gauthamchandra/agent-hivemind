import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

export function layerViolations(files: readonly { path: string; text: string }[]): string[] {
  const failures: string[] = [];

  for (const file of files) {
    const relative = file.path.split(path.sep).join('/');
    const layer = layerOf(relative);

    if (relative.startsWith('src/core/') && platformName.test(file.text)) {
      failures.push(`${relative} names a platform`);
    }

    if (relative.endsWith('.test.ts')) continue;

    if (layer === null) {
      failures.push(`${relative} is not in a known layer`);
      continue;
    }

    for (const specifier of specifiers(file.text, relative)) {
      const imported = resolveImport(relative, specifier);

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

  return failures;
}

if (import.meta.main) {
  const files: { path: string; text: string }[] = [];

  for (const file of await sourceFiles(source)) {
    files.push({
      path: path.relative(root, file).split(path.sep).join('/'),
      text: await readFile(file, 'utf8'),
    });
  }

  const failures = layerViolations(files);

  if (failures.length > 0) {
    console.error(failures.join('\n'));
    process.exit(1);
  }
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

function specifiers(text: string, fileName: string): string[] {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = moduleSpecifier(node);

      if (specifier !== null) found.push(specifier);
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(source);

  return found;
}

function moduleSpecifier(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  const specifier = node.moduleSpecifier;

  if (specifier === undefined || !ts.isStringLiteral(specifier)) return null;

  return specifier.text;
}

function resolveImport(file: string, specifier: string): string | null {
  const normalized = file.split(path.sep).join('/');

  if (specifier.startsWith('@/')) {
    return `src/${specifier.slice(2)}`;
  }

  if (!specifier.startsWith('.')) return null;

  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(normalized), specifier));

  return resolved;
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
