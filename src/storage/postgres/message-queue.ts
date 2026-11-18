import { requireGroupId } from '@/domain/ids.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { claimedDelivery, droppedCopies, parseCopy } from '@/storage/postgres/message-rows.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many, one, readString, run } from '@/storage/postgres/store-query.ts';

const claimSql = `WITH head AS (
  SELECT DISTINCT ON (copy.recipient_id) copy.id
  FROM outbox_copies copy
  JOIN sessions recipient ON recipient.id = copy.recipient_id
  LEFT JOIN connection_send_pauses pause ON pause.connection_id = copy.connection_id
  WHERE copy.state IN ('queued', 'claimed')
    AND recipient.life IN ('live', 'released')
    AND recipient.platform_session_ref IS NOT NULL
    AND (pause.paused_until IS NULL OR pause.paused_until <= $3::timestamptz)
  ORDER BY copy.recipient_id, copy.sequence
)
UPDATE outbox_copies copy
SET state = 'claimed', claim_generation = copy.claim_generation + 1,
    claimed_by = $1, claimed_until = $2::timestamptz
WHERE copy.id = (
  SELECT head.id FROM head
  JOIN outbox_copies candidate ON candidate.id = head.id
  WHERE candidate.state = 'queued' AND candidate.next_attempt_at <= $3::timestamptz
  ORDER BY candidate.sequence LIMIT 1
) AND copy.state = 'queued'
RETURNING copy.*`;

const expiredSql = `UPDATE outbox_copies AS copy
SET state = 'dropped', outcome_reason = 'expired', claimed_by = NULL, claimed_until = NULL
FROM sessions AS recipient
WHERE copy.recipient_id = recipient.id
  AND copy.state = 'queued'
  AND copy.created_at <= $1::timestamptz
RETURNING copy.message_id, copy.recipient_id, copy.workspace_id, copy.group_id,
          recipient.task_id, copy.outcome_reason`;

const unavailableSql = `UPDATE outbox_copies AS copy
SET state = 'dropped',
    outcome_reason = CASE recipient.life
      WHEN 'ended' THEN 'recipient_ended' ELSE 'recipient_start_failed' END,
    claimed_by = NULL, claimed_until = NULL
FROM sessions AS recipient
WHERE copy.recipient_id = recipient.id
  AND copy.state = 'queued'
  AND recipient.life IN ('ended', 'start_failed')
  AND ($1::text IS NULL OR recipient.id = $1)
RETURNING copy.message_id, copy.recipient_id, copy.workspace_id, copy.group_id,
          recipient.task_id, copy.outcome_reason`;

export function queueWork(
  sql: Sql
): Pick<
  UnitOfWork,
  | 'releaseExpiredClaims'
  | 'lockGroupsWithOutbox'
  | 'dropExpiredCopies'
  | 'dropUnavailableCopies'
  | 'claimDelivery'
  | 'takeMessageBudget'
  | 'pauseConnection'
  | 'settleCopy'
> {
  return {
    releaseExpiredClaims: now =>
      run(
        sql,
        `UPDATE outbox_copies
         SET state = 'queued', claimed_by = NULL, claimed_until = NULL
         WHERE state = 'claimed' AND claimed_until <= $1::timestamptz`,
        [now]
      ),
    lockGroupsWithOutbox: async deadline => {
      const locked = await many(
        sql,
        `SELECT id FROM groups
         WHERE id IN (
           SELECT copy.group_id
           FROM outbox_copies copy
           JOIN sessions recipient ON recipient.id = copy.recipient_id
           WHERE copy.state IN ('queued', 'claimed')
             AND (
               copy.created_at <= $1::timestamptz
               OR recipient.life IN ('ended', 'start_failed')
             )
         )
         ORDER BY id
         FOR UPDATE`,
        [deadline]
      );

      return locked.map(row => requireGroupId(readString(row, 'id')));
    },
    dropExpiredCopies: deadline => droppedCopies(sql, expiredSql, [deadline]),
    dropUnavailableCopies: sessionId => droppedCopies(sql, unavailableSql, [sessionId ?? null]),
    claimDelivery: (workerId, now, until) => claim(sql, workerId, now, until),
    takeMessageBudget: (connectionId, windowStart, ceiling) =>
      takeBudget(sql, connectionId, windowStart, ceiling),
    pauseConnection: (connectionId, until) =>
      run(
        sql,
        `INSERT INTO connection_send_pauses (connection_id, paused_until)
         VALUES ($1, $2::timestamptz)
         ON CONFLICT (connection_id) DO UPDATE SET paused_until = EXCLUDED.paused_until`,
        [connectionId, until]
      ),
    settleCopy: input => settle(sql, input),
  };
}

async function claim(sql: Sql, workerId: string, now: string, until: string) {
  const row = await one(sql, claimSql, [workerId, until, now]);

  if (row === null) return null;

  return claimedDelivery(sql, parseCopy(row));
}

async function takeBudget(sql: Sql, connectionId: string, windowStart: string, ceiling: number) {
  const row = await one(
    sql,
    `INSERT INTO connection_rate_windows (connection_id, window_start_at, message_calls)
     VALUES ($1, $2::timestamptz, 1)
     ON CONFLICT (connection_id, window_start_at)
     DO UPDATE SET message_calls = connection_rate_windows.message_calls + 1
     WHERE connection_rate_windows.message_calls < $3
     RETURNING message_calls`,
    [connectionId, windowStart, ceiling]
  );

  return row !== null;
}

async function settle(sql: Sql, input: Parameters<UnitOfWork['settleCopy']>[0]) {
  const row = await one(
    sql,
    `UPDATE outbox_copies
     SET state = $3, attempts = $4, busy_streak = $5, next_attempt_at = $6::timestamptz,
         outcome_reason = $7, delivered_at = $8::timestamptz, claimed_by = NULL, claimed_until = NULL
     WHERE id = $1 AND claim_generation = $2 AND state = 'claimed'
     RETURNING id`,
    [
      input.id,
      input.generation,
      input.state,
      input.attempts,
      input.busyStreak,
      input.nextAttemptAt,
      input.reason,
      input.deliveredAt,
    ]
  );

  return row !== null;
}
