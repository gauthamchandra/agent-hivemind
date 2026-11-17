import type { GroupId, PersonId, SessionId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type { Group, SessionRecord, SessionRole } from '@/domain/model.ts';
import type { PlatformErrorClass } from '@/domain/platform.ts';
import type { StartSessionInput } from '@/ports/platform.ts';

export const routeStart = 'session.start';

export function startRoute(replacementOf: SessionId | null): string {
  return replacementOf === null ? routeStart : `session.replace:${replacementOf}`;
}
export const routeEnroll = 'session.enroll';
export const enrollmentTtlMs = 15 * 60 * 1000;
export const spawnWindowMs = 60 * 60 * 1000;

export type CrashPoint =
  | 'after_reserve'
  | 'after_platform_accept'
  | 'after_end_intent'
  | 'after_platform_end';

/** The process stopped after a committed step. Recovery continues from the row. */
export class StoppedProcess extends Error {
  readonly point: CrashPoint;

  constructor(point: CrashPoint) {
    super(`The process stopped at ${point}.`);
    this.name = 'StoppedProcess';
    this.point = point;
  }
}

export type StartOutcome = {
  outcome: 'live' | 'released' | 'ended' | 'start_pending' | 'refused';
  session: SessionRecord;
  errorClass?: PlatformErrorClass;
};

export type StartInput = {
  workspaceId: WorkspaceId;
  groupId: GroupId;
  taskId: TaskId;
  role: SessionRole;
  instructions: string;
  actor: { kind: 'person'; personId: PersonId } | { kind: 'session'; sessionId: SessionId };
  idempotencyKey: string;
  bodyHash: string;
  replacementOf: SessionId | null;
  crashAt?: CrashPoint;
};

export type Reserved =
  | { replay: true; session: SessionRecord }
  | {
      replay: false;
      session: SessionRecord;
      startAttemptId: string;
      connectionId: Group['connection_id'];
      platformInput: StartSessionInput;
    };
