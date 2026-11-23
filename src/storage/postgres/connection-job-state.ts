import type { ConnectionJobState } from '@/domain/background-jobs.ts';
import { requireConnectionId, requireWorkspaceId } from '@/domain/ids.ts';
import type { UnitOfWork } from '@/ports/storage.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many, readString } from '@/storage/postgres/store-query.ts';

export function connectionJobState(
  sql: Sql
): Pick<UnitOfWork, 'listConnections' | 'saveConnectionJobState'> {
  return {
    async listConnections() {
      const rows = await many(sql, 'SELECT id, workspace_id FROM connections ORDER BY id', []);

      return rows.map(row => ({
        id: requireConnectionId(readString(row, 'id')),
        workspaceId: requireWorkspaceId(readString(row, 'workspace_id')),
      }));
    },

    async saveConnectionJobState(state: ConnectionJobState) {
      await sql.query(
        `INSERT INTO connection_job_state (connection_id, workspace_id, failing)
         VALUES ($1, $2, $3)
         ON CONFLICT (connection_id) DO UPDATE
         SET workspace_id = EXCLUDED.workspace_id, failing = EXCLUDED.failing`,
        [state.connectionId, state.workspaceId, state.failing]
      );
    },
  };
}
