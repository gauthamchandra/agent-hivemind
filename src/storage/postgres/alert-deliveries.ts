import type { AlertDelivery } from '@/domain/background-jobs.ts';
import { requireAlertId, requireWorkspaceId } from '@/domain/ids.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import { timeText } from '@/storage/postgres/job-parse.ts';
import type { Row, Sql } from '@/storage/postgres/store-query.ts';
import { many, readNumber, readString, unreadable } from '@/storage/postgres/store-query.ts';

export function alertDeliveries(
  sql: Sql
): Pick<
  UnitOfWork,
  'outstandingAlertDeliveries' | 'recordAlertDeliveryAttempt' | 'finishAlertDelivery'
> {
  return {
    async outstandingAlertDeliveries() {
      const rows = await many(
        sql,
        `SELECT * FROM alert_deliveries WHERE state IN ('sending', 'failed') ORDER BY created_at, id`,
        []
      );

      return rows.map(parseAlertDelivery);
    },

    async recordAlertDeliveryAttempt(input) {
      await sql.query(
        `INSERT INTO alert_deliveries (id, workspace_id, alert_id, state, created_at, updated_at)
         VALUES ($1, $2, $3, 'sending', $4::timestamptz, $4::timestamptz)
         ON CONFLICT (id) DO UPDATE
         SET state = 'sending', updated_at = EXCLUDED.updated_at,
             attempts = alert_deliveries.attempts + 1
         WHERE alert_deliveries.state IN ('sending', 'failed')`,
        [input.id, input.workspaceId, input.alertId, input.now]
      );
    },

    async finishAlertDelivery(id, state, now) {
      const finished = await sql.query<Row>(
        `UPDATE alert_deliveries
         SET state = $2, updated_at = $3::timestamptz
         WHERE id = $1 AND state IN ('sending', 'failed')
         RETURNING alert_id`,
        [id, state, now]
      );
      const alertId = finished.rows[0]?.alert_id;

      if (state === 'sent' && typeof alertId === 'string') {
        await sql.query('UPDATE alerts SET notified_at = $2::timestamptz WHERE id = $1', [
          alertId,
          now,
        ]);
      }
    },
  };
}

function parseAlertDelivery(row: Row): AlertDelivery {
  const state = readString(row, 'state');

  if (state !== 'sending' && state !== 'sent' && state !== 'failed' && state !== 'expired') {
    throw unreadable();
  }

  return {
    id: readString(row, 'id'),
    workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
    alertId: requireAlertId(readString(row, 'alert_id')),
    state,
    attempts: readNumber(row, 'attempts'),
    createdAt: timeText(row, 'created_at'),
    updatedAt: timeText(row, 'updated_at'),
  };
}
