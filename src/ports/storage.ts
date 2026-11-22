import type {
  AlertDelivery,
  AlertRecord,
  AlertRule,
  JobName,
  JobSnapshot,
  PlannedAction,
  SessionJobState,
} from '@/domain/background-jobs.ts';
import type {
  AlertId,
  ConnectionId,
  CopyId,
  GroupId,
  MessageId,
  PersonId,
  SessionId,
  TaskId,
  WaitId,
  WorkspaceId,
} from '@/domain/ids.ts';
import type {
  ClaimedDelivery,
  DroppedCopy,
  MessageRecord,
  OutboxCopy,
  WaitRecord,
} from '@/domain/message.ts';
import type {
  ContextNote,
  Group,
  OperatorKeyRecord,
  Person,
  SessionRecord,
  Task,
  TaskEvent,
  Workspace,
} from '@/domain/model.ts';

export type Occupancy = {
  live_sessions: number;
  planner: number;
  challenger: number;
  implementer: number;
  total_sessions: number;
  workspace_live_sessions: number;
};

export type OccupancyDelta = {
  live_sessions: number;
  planner: number;
  challenger: number;
  implementer: number;
  total_sessions: number;
};

export type IdempotencyRecord = {
  body_hash: string;
  record_id: string | null;
  completed: boolean;
  response: unknown;
};

export type EnrollmentCodeRecord = {
  id: string;
  workspace_id: WorkspaceId;
  session_id: SessionId;
  code_hash: string;
  expires_at: string | null;
  used_at: string | null;
  attempts: number;
  voided_at: string | null;
  created_at: string;
};

export type ChildCounts = {
  childCount: number;
  openChildCount: number;
  failedChildCount: number;
};

/** The reads and writes of one database transaction. Callers do not commit it themselves. */
export interface UnitOfWork {
  countWorkspaces(): Promise<number>;
  countPeople(): Promise<number>;
  hasUsableOperatorKey(now: string): Promise<boolean>;
  insertWorkspace(workspace: Workspace): Promise<void>;
  workspace(id: WorkspaceId): Promise<Workspace | null>;
  insertPerson(person: Person): Promise<void>;
  people(workspaceId: WorkspaceId): Promise<Person[]>;
  person(workspaceId: WorkspaceId, id: PersonId): Promise<Person | null>;
  insertOperatorKey(record: OperatorKeyRecord): Promise<void>;
  operatorKeyByHash(hash: string): Promise<OperatorKeyRecord | null>;
  lockGroup(workspaceId: WorkspaceId, id: GroupId): Promise<Group | null>;
  insertGroup(group: Group): Promise<void>;
  updateGroup(group: Group): Promise<void>;
  insertNotes(notes: readonly ContextNote[]): Promise<void>;
  insertTask(task: Task): Promise<void>;
  lockTask(workspaceId: WorkspaceId, id: TaskId): Promise<Task | null>;
  tasks(workspaceId: WorkspaceId, groupId: GroupId): Promise<Task[]>;
  childCounts(workspaceId: WorkspaceId, groupId: GroupId): Promise<ChildCounts>;
  openChildren(workspaceId: WorkspaceId, groupId: GroupId, parentId: TaskId): Promise<Task[]>;
  updateTask(task: Task): Promise<void>;
  nextSequence(groupId: GroupId): Promise<number>;
  insertEvent(event: TaskEvent): Promise<void>;
  lockWorkspace(id: WorkspaceId): Promise<Workspace | null>;
  occupancy(workspaceId: WorkspaceId, groupId: GroupId): Promise<Occupancy>;
  addOccupancy(workspaceId: WorkspaceId, groupId: GroupId, delta: OccupancyDelta): Promise<void>;
  spawnCount(groupId: GroupId, since: string): Promise<number>;
  insertSpawn(row: {
    id: string;
    workspaceId: WorkspaceId;
    groupId: GroupId;
    sessionId: SessionId;
    at: string;
  }): Promise<void>;
  holderCount(taskId: TaskId, role: string): Promise<number>;
  liveOnTask(taskId: TaskId, role: string): Promise<number>;
  replacementCount(taskId: TaskId, role: string): Promise<number>;
  nextAttempt(taskId: TaskId, role: string): Promise<number>;
  implementerEverStarted(groupId: GroupId): Promise<boolean>;
  insertSession(session: SessionRecord): Promise<void>;
  updateSession(session: SessionRecord): Promise<void>;
  lockSession(workspaceId: WorkspaceId, id: SessionId): Promise<SessionRecord | null>;
  sessionById(id: SessionId): Promise<SessionRecord | null>;
  sessionByTokenHash(hash: string): Promise<SessionRecord | null>;
  sessionByEndReceipt(hash: string): Promise<SessionRecord | null>;
  touchReport(sessionId: SessionId, at: string): Promise<void>;
  insertEnrollmentCode(code: EnrollmentCodeRecord): Promise<void>;
  enrollmentByHash(hash: string): Promise<EnrollmentCodeRecord | null>;
  openEnrollmentCode(sessionId: SessionId): Promise<EnrollmentCodeRecord | null>;
  saveEnrollmentCode(code: EnrollmentCodeRecord): Promise<void>;
  voidEnrollmentCodes(sessionId: SessionId, at: string): Promise<void>;
  findIdempotency(
    workspaceId: WorkspaceId,
    callerKind: string,
    callerId: string,
    route: string,
    key: string
  ): Promise<IdempotencyRecord | null>;
  insertIdempotency(row: {
    workspaceId: WorkspaceId;
    callerKind: string;
    callerId: string;
    route: string;
    key: string;
    bodyHash: string;
    recordId: string | null;
    response?: unknown;
    completed: boolean;
    at: string;
  }): Promise<void>;
  insertMessage(message: MessageRecord): Promise<void>;
  insertCopy(copy: OutboxCopy): Promise<void>;
  nextCopySequence(recipientId: SessionId): Promise<number>;
  countSenderMessages(senderId: string, since: string): Promise<number>;
  oldestSenderMessage(senderId: string, since: string): Promise<string | null>;
  countBroadcasts(senderId: string, since: string): Promise<number>;
  oldestBroadcast(senderId: string, since: string): Promise<string | null>;
  countOpenQuestions(senderId: string): Promise<number>;
  findMessage(
    workspaceId: WorkspaceId,
    groupId: GroupId,
    id: MessageId
  ): Promise<MessageRecord | null>;
  loadMessage(id: MessageId): Promise<MessageRecord | null>;
  copiesOf(messageId: MessageId): Promise<OutboxCopy[]>;
  waitsInGroup(workspaceId: WorkspaceId, groupId: GroupId): Promise<WaitRecord[]>;
  insertWait(wait: WaitRecord): Promise<void>;
  clearQuestionWaits(questionId: MessageId, answererId: SessionId, at: string): Promise<void>;
  clearWait(waitId: WaitId, waiterId: SessionId, at: string): Promise<WaitRecord | null>;
  clearSessionWaits(sessionId: SessionId, at: string): Promise<void>;
  groupSessions(workspaceId: WorkspaceId, groupId: GroupId): Promise<SessionRecord[]>;
  releaseExpiredClaims(now: string): Promise<void>;
  /** Lock every group with a copy to drop or deliver, in id order, and return their ids. */
  lockGroupsWithOutbox(deadline: string): Promise<GroupId[]>;
  dropExpiredCopies(deadline: string): Promise<DroppedCopy[]>;
  dropUnavailableCopies(sessionId?: SessionId): Promise<DroppedCopy[]>;
  claimDelivery(workerId: string, now: string, until: string): Promise<ClaimedDelivery | null>;
  takeMessageBudget(connectionId: string, windowStart: string, ceiling: number): Promise<boolean>;
  pauseConnection(connectionId: string, until: string): Promise<void>;
  settleCopy(input: {
    id: CopyId;
    generation: number;
    state: OutboxCopy['state'];
    attempts: number;
    busyStreak: number;
    nextAttemptAt: string;
    reason: OutboxCopy['outcome_reason'];
    deliveredAt: string | null;
  }): Promise<boolean>;
  inbox(
    workspaceId: WorkspaceId,
    groupId: GroupId,
    sessionId: SessionId,
    kind: string | null,
    unanswered: boolean
  ): Promise<MessageRecord[]>;
  mailPage(
    workspaceId: WorkspaceId,
    groupId: GroupId
  ): Promise<{ messages: MessageRecord[]; copies: OutboxCopy[]; removed: number }>;
  takeJobLock(input: {
    job: JobName;
    lockedBy: string;
    now: string;
    expiresAt: string;
    dueAt: string;
  }): Promise<number | null>;
  holdJobLock(job: JobName, lockId: number, now: string): Promise<boolean>;
  jobLockStartedAt(job: JobName): Promise<string | null>;
  insertPlannedAction(input: {
    id: string;
    job: JobName;
    action: string;
    targetId: string;
    workspaceId: WorkspaceId;
    lockId: number;
    now: string;
  }): Promise<'inserted' | 'open' | 'stale'>;
  openPlannedActions(job: JobName): Promise<PlannedAction[]>;
  finishPlannedAction(id: string, job: JobName, lockId: number, now: string): Promise<boolean>;
  saveSessionJobState(jobState: SessionJobState, scope: 'usage_poll' | 'reaper'): Promise<void>;
  loadJobSnapshot(): Promise<JobSnapshot>;
  openAlertByKey(rule: AlertRule, targetId: string): Promise<AlertRecord | null>;
  insertAlert(alert: AlertRecord): Promise<void>;
  touchAlert(id: string, now: string): Promise<void>;
  clearAlert(id: string, now: string): Promise<void>;
  updateAlertReason(id: string, reason: string, now: string): Promise<void>;
  countEscalations(groupId: GroupId, since: string): Promise<number>;
  /** The open alerts of the rules this release knows. */
  openAlerts(): Promise<AlertRecord[]>;
  /** The ids of every open alert, whatever its rule. */
  openAlertIds(): Promise<string[]>;
  outstandingAlertDeliveries(): Promise<AlertDelivery[]>;
  /** Record a delivery as `sending`, or put one that is `sending` or `failed` back to `sending`. Each call counts as one attempt. */
  recordAlertDeliveryAttempt(input: {
    id: string;
    workspaceId: WorkspaceId;
    alertId: AlertId;
    now: string;
  }): Promise<void>;
  /** Close an outstanding delivery. `sent` also records when the alert was last notified. */
  finishAlertDelivery(id: string, state: 'sent' | 'failed' | 'expired', now: string): Promise<void>;
  correctCounters(): Promise<string[]>;
}

export interface Store {
  migrate(): Promise<void>;
  transact<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T>;
  group(workspaceId: WorkspaceId, groupId: GroupId): Promise<Group | null>;
  tasks(workspaceId: WorkspaceId, groupId: GroupId): Promise<Task[]>;
  events(workspaceId: WorkspaceId, groupId: GroupId): Promise<TaskEvent[]>;
  sessions(workspaceId: WorkspaceId, groupId: GroupId): Promise<SessionRecord[]>;
  session(workspaceId: WorkspaceId, id: SessionId): Promise<SessionRecord | null>;
  occupancy(workspaceId: WorkspaceId, groupId: GroupId): Promise<Occupancy>;
  spawnCount(groupId: GroupId, since: string): Promise<number>;
  connection(workspaceId: WorkspaceId): Promise<ConnectionId | null>;
  saveConnection(row: {
    workspaceId: WorkspaceId;
    id: ConnectionId;
    adapter: string;
    createdAt: string;
  }): Promise<void>;
}
