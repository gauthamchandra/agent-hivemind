import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../../docs/adr/', import.meta.url));

type DecisionRecord = { file: string; number: number; text: string };

async function readDecisionRecords(): Promise<DecisionRecord[]> {
  const files = (await readdir(directory)).filter(name => /^\d{4}-.+\.md$/.test(name)).sort();

  return Promise.all(
    files.map(async file => ({
      file,
      number: Number(file.slice(0, 4)),
      text: await readFile(`${directory}${file}`, 'utf8'),
    }))
  );
}

function laterRecordsMentionedBy(record: DecisionRecord): number[] {
  return record.text
    .split('\n')
    .filter(line => !line.startsWith('Superseded by'))
    .flatMap(line => [...line.matchAll(/ADR\s+0*(\d+)|\b(\d{4})-[a-z0-9-]+\.md/g)])
    .map(match => Number(match[1] ?? match[2]))
    .filter(mentioned => mentioned > record.number);
}

test('no decision record mentions a later one unless its Status says it is superseded by it', async () => {
  const records = await readDecisionRecords();

  const forwardMentions = records.flatMap(record =>
    laterRecordsMentionedBy(record).map(
      later => `${record.file} mentions ADR ${String(later).padStart(4, '0')}`
    )
  );

  expect(records.length).toBeGreaterThan(0);
  expect(forwardMentions).toEqual([]);
});
