import { expect, test } from 'bun:test';
import { runReaper } from '@/core/reaper.ts';
import { endSession } from '@/core/session-end.ts';
import { defaultWorkspaceId } from '@/domain/ids.ts';
import { team } from '@/testing/team.ts';

test('an end the platform has forgotten finishes and clears the pending stop', async () => {
  const ctx = await team();

  ctx.simulated.queueError('end', 'not_found');

  const ended = await endSession(ctx.deps, ctx.platforms, {
    workspaceId: defaultWorkspaceId,
    sessionId: ctx.planner.id,
    actor: { kind: 'service' },
    reason: 'The platform no longer has this session.',
  });
  const stored = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);

  expect(ended.life).toBe('ended');
  expect(ended.platform_stop_pending).toBe(false);
  expect(stored?.platform_stop_pending).toBe(false);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(1);
});

test('the reaper clears a pending stop the platform has already forgotten', async () => {
  const ctx = await team();

  await ctx.db.query(
    `UPDATE sessions
     SET life = 'ended', ended_at = created_at, last_status = 'stopped',
         final_usage_pending = false, platform_stop_pending = true, token_hash = NULL
     WHERE id = $1`,
    [ctx.planner.id]
  );
  ctx.simulated.queueError('end', 'not_found');
  await runReaper(ctx.deps, ctx.platforms, { workerId: 'worker' });

  const stopped = await ctx.deps.store.session(defaultWorkspaceId, ctx.planner.id);
  const snapshot = await ctx.deps.store.transact(tx => tx.loadJobSnapshot());

  expect(stopped?.life).toBe('ended');
  expect(stopped?.platform_stop_pending).toBe(false);
  expect(snapshot.sessions.map(session => session.id)).not.toContain(ctx.planner.id);
  expect(await ctx.deps.store.transact(tx => tx.openPlannedActions('reaper'))).toHaveLength(0);
  expect(ctx.simulated.calls().filter(call => call === 'end')).toHaveLength(1);
});
