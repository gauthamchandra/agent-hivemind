import type { GroupId, PersonId, TaskId, WorkspaceId } from '@/domain/ids.ts';
import type {
  ContextNote,
  Group,
  OperatorKeyRecord,
  Person,
  Task,
  TaskEvent,
  Workspace,
} from '@/domain/model.ts';

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
}

export interface Store {
  migrate(): Promise<void>;
  transact<T>(work: (tx: UnitOfWork) => Promise<T>): Promise<T>;
  group(workspaceId: WorkspaceId, groupId: GroupId): Promise<Group | null>;
  tasks(workspaceId: WorkspaceId, groupId: GroupId): Promise<Task[]>;
  events(workspaceId: WorkspaceId, groupId: GroupId): Promise<TaskEvent[]>;
}
