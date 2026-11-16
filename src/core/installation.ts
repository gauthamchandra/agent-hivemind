import type { ServiceDeps } from '@/core/deps.ts';
import { HivemindError } from '@/domain/errors.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import type { OperatorKeyRecord, OperatorKeyRole, Person, Workspace } from '@/domain/model.ts';
import { selfHostedLimits } from '@/domain/model.ts';
import { operatorKeySecret, sha256Hex } from '@/domain/secret.ts';
import { formatTime, parseTime } from '@/domain/time.ts';
import type { UnitOfWork } from '@/ports/storage.ts';

const bootstrapTtlMs = 24 * 60 * 60 * 1000;

export type Installation = {
  workspace: Workspace;
  bootstrapSecret: string | null;
};

/**
 * Open the database. The first call on an empty store creates the default workspace
 * and a bootstrap key, and returns that secret once. A later open mints a replacement
 * only when every existing key is expired or revoked and no person exists yet.
 */
export async function openInstallation(deps: ServiceDeps): Promise<Installation> {
  return deps.store.transact(async tx => {
    const workspace = await ensureWorkspace(deps, tx);
    const now = formatTime(deps.clock.now());

    if ((await tx.countPeople()) > 0 || (await tx.hasUsableOperatorKey(now))) {
      return { workspace, bootstrapSecret: null };
    }

    const secret = operatorKeySecret(deps.random);
    const record: OperatorKeyRecord = {
      id: deps.ids.operatorKey(),
      workspace_id: workspace.id,
      name: 'bootstrap',
      role: 'bootstrap',
      key_hash: sha256Hex(secret),
      person_id: null,
      created_at: now,
      expires_at: formatTime(new Date(deps.clock.now().getTime() + bootstrapTtlMs)),
      revoked_at: null,
    };

    await tx.insertOperatorKey(record);

    return { workspace, bootstrapSecret: secret };
  });
}

export async function createFirstAdministrator(
  deps: ServiceDeps,
  input: { bootstrapSecret: string; displayName: string }
): Promise<Person> {
  return deps.store.transact(async tx => {
    await requireBootstrap(deps, tx, input.bootstrapSecret);

    if ((await tx.countPeople()) > 0) {
      throw new HivemindError('conflict', 'The workspace already has a person.');
    }

    if (input.displayName.length > 200) {
      throw new HivemindError('validation_failed', 'The display name is too long.', {
        field: 'display_name',
      });
    }

    const person: Person = {
      id: deps.ids.person(),
      workspace_id: defaultWorkspaceId,
      display_name: input.displayName,
      workspace_role: 'administrator',
      account_id: null,
      status: 'active',
      created_at: formatTime(deps.clock.now()),
    };

    await tx.insertPerson(person);

    return person;
  });
}

export async function createOperatorKey(
  deps: ServiceDeps,
  input: { bootstrapSecret: string; name: string; role: OperatorKeyRole; expiresAt: string | null }
): Promise<{ record: OperatorKeyRecord; secret: string }> {
  return deps.store.transact(async tx => {
    const bootstrap = await requireBootstrap(deps, tx, input.bootstrapSecret);
    const people = await tx.people(bootstrap.workspace_id);
    const creator = people[0];

    if (creator === undefined) {
      throw new HivemindError(
        'conflict',
        'Create the first administrator before creating operator keys.'
      );
    }

    if (input.role !== 'reader' && input.role !== 'creator' && input.role !== 'administrator') {
      throw new HivemindError(
        'validation_failed',
        'The bootstrap key cannot create another bootstrap key.',
        {
          field: 'role',
        }
      );
    }

    if (input.name.trim().length === 0 || input.name.length > 80) {
      throw new HivemindError('validation_failed', 'An operator key needs a name.', {
        field: 'name',
      });
    }

    const expiresAt = input.expiresAt;

    if (expiresAt !== null && parseTime(expiresAt).getTime() <= deps.clock.now().getTime()) {
      throw new HivemindError('validation_failed', 'The key expiry is already in the past.', {
        field: 'expires_at',
      });
    }

    const secret = operatorKeySecret(deps.random);
    const record: OperatorKeyRecord = {
      id: deps.ids.operatorKey(),
      workspace_id: bootstrap.workspace_id,
      name: input.name,
      role: input.role,
      key_hash: sha256Hex(secret),
      person_id: creator.id,
      created_at: formatTime(deps.clock.now()),
      expires_at: expiresAt,
      revoked_at: null,
    };

    await tx.insertOperatorKey(record);

    return { record, secret };
  });
}

async function ensureWorkspace(deps: ServiceDeps, tx: UnitOfWork): Promise<Workspace> {
  if ((await tx.countWorkspaces()) === 0) {
    const workspace: Workspace = {
      id: defaultWorkspaceId,
      name: 'Default',
      status: 'active',
      limits: selfHostedLimits,
      created_at: formatTime(deps.clock.now()),
    };

    await tx.insertWorkspace(workspace);

    return workspace;
  }

  const existing = await tx.workspace(defaultWorkspaceId);

  if (existing === null) {
    throw new HivemindError(
      'unavailable',
      'The database has a workspace but not the default workspace.'
    );
  }

  return existing;
}

async function requireBootstrap(
  deps: ServiceDeps,
  tx: UnitOfWork,
  secret: string
): Promise<OperatorKeyRecord> {
  const record = await tx.operatorKeyByHash(sha256Hex(secret));

  if (record === null || record.role !== 'bootstrap' || record.revoked_at !== null) {
    throw new HivemindError('unauthenticated', 'The bootstrap key is not valid.');
  }

  if (
    record.expires_at === null ||
    deps.clock.now().getTime() >= parseTime(record.expires_at).getTime()
  ) {
    throw new HivemindError('unauthenticated', 'The bootstrap key has expired.');
  }

  return record;
}
