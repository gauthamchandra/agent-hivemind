import type { Group, SessionRecord, Task } from '@/domain/model.ts';

export function storedTransition(response: unknown): { task: Task; group: Group } | null {
  const task = storedTask(response) ?? storedNamedTask(response, 'root');
  const group = storedGroup(response);

  if (task === null || group === null) return null;

  return { task, group };
}

export function storedTask(response: unknown): Task | null {
  return storedNamedTask(response, 'task');
}

export function storedSession(response: unknown): SessionRecord | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, 'session');

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const life = Reflect.get(value, 'life');

  if (typeof id !== 'string' || typeof life !== 'string') return null;

  return value as SessionRecord;
}

function storedNamedTask(response: unknown, field: string): Task | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, field);

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const state = Reflect.get(value, 'state');
  const version = Reflect.get(value, 'version');

  if (typeof id !== 'string' || typeof state !== 'string' || typeof version !== 'number') {
    return null;
  }

  return value as Task;
}

function storedGroup(response: unknown): Group | null {
  if (typeof response !== 'object' || response === null) return null;

  const value = Reflect.get(response, 'group');

  if (typeof value !== 'object' || value === null) return null;

  const id = Reflect.get(value, 'id');
  const status = Reflect.get(value, 'status');

  if (typeof id !== 'string' || typeof status !== 'string') return null;

  return value as Group;
}
