import { call } from '@/cli/call.ts';
import type { Io } from '@/cli/io.ts';

export function sendMessage(
  io: Io,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return call(io, 'POST', '/v1/messages', body, true);
}

export function listInbox(io: Io, kind: string | undefined): Promise<Record<string, unknown>> {
  const path =
    kind === undefined ? '/v1/messages' : `/v1/messages?kind=${encodeURIComponent(kind)}`;

  return call(io, 'GET', path, undefined, true);
}
