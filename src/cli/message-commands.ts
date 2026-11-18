import { readFile } from 'node:fs/promises';
import { escalate, listInbox, sendMessage } from '@/cli/hivemind-client.ts';
import { flag, type Io, optional, type Parsed, print } from '@/cli/io.ts';

type Outgoing = {
  kind: string;
  recipientId?: string;
  inReplyTo?: string;
  waitSeconds?: string;
};

export async function messageCommand(io: Io, parsed: Parsed): Promise<number | null> {
  const [command] = parsed.positionals;

  switch (command) {
    case 'send':
      return post(
        io,
        parsed,
        chosen('note', flag(parsed, 'to'), undefined, optional(parsed, 'wait'))
      );
    case 'ask':
      return post(
        io,
        parsed,
        chosen('question', flag(parsed, 'to'), undefined, optional(parsed, 'wait'))
      );
    case 'answer':
      return post(
        io,
        parsed,
        chosen('answer', flag(parsed, 'to'), flag(parsed, 'message'), optional(parsed, 'wait'))
      );
    case 'relay':
      return post(
        io,
        parsed,
        chosen('relayed_instruction', undefined, undefined, optional(parsed, 'wait'))
      );
    case 'inbox':
      return inbox(io, parsed);
    case 'escalate':
      return escalateToOwner(io, parsed);
    default:
      return null;
  }
}

async function escalateToOwner(io: Io, parsed: Parsed): Promise<number> {
  const response = await escalate(io, flag(parsed, 'reason'));

  return print(
    io,
    response,
    parsed.json,
    'Escalated. The owner is told on the next check. Do not escalate again unless the reason changed.'
  );
}

function chosen(
  kind: string,
  recipientId: string | undefined,
  inReplyTo: string | undefined,
  waitSeconds: string | undefined
): Outgoing {
  const message: Outgoing = { kind };

  if (recipientId !== undefined) message.recipientId = recipientId;
  if (inReplyTo !== undefined) message.inReplyTo = inReplyTo;
  if (waitSeconds !== undefined) message.waitSeconds = waitSeconds;

  return message;
}

async function post(io: Io, parsed: Parsed, message: Outgoing): Promise<number> {
  const body: Record<string, unknown> = { kind: message.kind, body: await messageBody(parsed) };

  if (message.recipientId !== undefined) body.recipient_id = message.recipientId;
  if (message.inReplyTo !== undefined) body.in_reply_to = message.inReplyTo;
  if (message.kind === 'question' || message.waitSeconds !== undefined) body.record_wait = true;
  if (message.waitSeconds !== undefined) body.wait_seconds = Number(message.waitSeconds);

  const response = await sendMessage(io, body);
  const sent = response.message;
  const id =
    typeof sent === 'object' && sent !== null && 'id' in sent ? String(sent.id) : 'message';

  return print(
    io,
    response,
    parsed.json,
    `Sent ${id}. A recipient who is busy does not bounce the message: it stays queued and is tried again. Do not send it again.`
  );
}

async function inbox(io: Io, parsed: Parsed): Promise<number> {
  const response = await listInbox(io, optional(parsed, 'kind'));
  const messages = Array.isArray(response.messages) ? response.messages : [];
  const text = messages
    .map(item => {
      if (typeof item !== 'object' || item === null) return '';

      const row = item as { id?: string; kind?: string; body?: string };

      return `${row.kind ?? ''} ${row.id ?? ''} ${row.body ?? ''}`.trim();
    })
    .join('\n');

  return print(io, response, parsed.json, text.length === 0 ? 'No messages.' : text);
}

async function messageBody(parsed: Parsed): Promise<string> {
  const file = optional(parsed, 'body-file');

  if (file !== undefined) return readFile(file, 'utf8');

  return flag(parsed, 'body');
}
