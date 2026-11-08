import type { PoolClient } from 'pg';
import { pool } from './db.js';

// Runs `work` in one transaction scoped to one tenant: row-level security (migrations/002_app_role.sql) then only lets
// it see and change that tenant's rows.
//
// The tenant is set with set_config(..., true), which lasts until the end of the transaction. Pooled connections are
// reused across requests, so a session-wide setting would stay on the connection and be picked up by whatever runs on
// it next. This way a connection always goes back to the pool without a tenant, and a query that runs without
// withTenant sees no rows at all.
export const withTenant = async <T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // If even the rollback fails, the connection is unusable: release(error) drops it instead of pooling it.
    await client.query('ROLLBACK').catch((rollbackError: Error) => (broken = rollbackError));
    throw error;
  } finally {
    client.release(broken);
  }
};
