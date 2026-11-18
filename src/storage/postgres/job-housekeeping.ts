import type { UnitOfWork } from '@/ports/storage.ts';
import type { Sql } from '@/storage/postgres/store-query.ts';
import { many, readString } from '@/storage/postgres/store-query.ts';

export function jobHousekeeping(sql: Sql): Pick<UnitOfWork, 'correctCounters'> {
  return {
    async correctCounters() {
      await sql.query('SELECT id FROM workspaces ORDER BY id FOR UPDATE');
      await sql.query('SELECT workspace_id, id FROM groups ORDER BY workspace_id, id FOR UPDATE');

      const groups = await many(
        sql,
        `WITH counted AS (
           SELECT g.id,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live')) AS live,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'planner') AS planner,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'challenger') AS challenger,
             (SELECT count(*)::int FROM sessions s
              WHERE s.group_id = g.id AND s.life IN ('starting', 'live') AND s.role = 'implementer') AS implementer,
             (SELECT count(*)::int FROM sessions s WHERE s.group_id = g.id) AS total
           FROM groups g
         )
         UPDATE groups g
         SET live_sessions = c.live,
             live_planner = c.planner,
             live_challenger = c.challenger,
             live_implementer = c.implementer,
             total_sessions = c.total
         FROM counted c
         WHERE g.id = c.id
           AND (g.live_sessions IS DISTINCT FROM c.live
             OR g.live_planner IS DISTINCT FROM c.planner
             OR g.live_challenger IS DISTINCT FROM c.challenger
             OR g.live_implementer IS DISTINCT FROM c.implementer
             OR g.total_sessions IS DISTINCT FROM c.total)
         RETURNING g.id`,
        []
      );

      await sql.query(
        `WITH counted AS (
           SELECT w.id,
             (SELECT count(*)::int FROM sessions s
              WHERE s.workspace_id = w.id AND s.life IN ('starting', 'live')) AS live
           FROM workspaces w
         )
         UPDATE workspaces w
         SET live_sessions = c.live
         FROM counted c
         WHERE w.id = c.id AND w.live_sessions IS DISTINCT FROM c.live`,
        []
      );

      return groups.map(row => readString(row, 'id'));
    },
  };
}
