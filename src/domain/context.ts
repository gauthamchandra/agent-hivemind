import { HivemindError } from '@/domain/errors.ts';
import { sha256Hex } from '@/domain/secret.ts';

const noteLimit = 16 * 1024;

export type NoteDraft = { name: string; body: string };

/** Render notes in the order given. An empty list renders as an empty section. */
export function renderContextNotes(notes: readonly NoteDraft[]): string {
  if (notes.length === 0) return '';

  const blocks = notes.map(note => `### ${note.name}\n${note.body}`);

  return `## Context notes\n\n${blocks.join('\n\n')}\n`;
}

export function fingerprintText(value: string): string {
  return sha256Hex(value);
}

export function requireContextNotes(notes: readonly NoteDraft[]): {
  notes: NoteDraft[];
  rendered: string;
  fingerprint: string;
} {
  const clean = notes.map(note => {
    if (note.name.trim().length === 0 || note.body.trim().length === 0) {
      throw new HivemindError('validation_failed', 'A context note needs a name and a body.', {
        field: 'notes',
      });
    }

    return { name: note.name, body: note.body };
  });
  const rendered = renderContextNotes(clean);

  if (Buffer.byteLength(rendered) > noteLimit) {
    throw new HivemindError('validation_failed', 'Context notes must fit in 16 KiB.', {
      field: 'notes',
    });
  }

  return { notes: clean, rendered, fingerprint: fingerprintText(rendered) };
}
