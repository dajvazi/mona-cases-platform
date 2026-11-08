import type { PoolClient } from 'pg';
import { pool } from './db.js';

// Runs `work` on a connection scoped to one tenant: row-level security (migrations/001_init.sql) then only lets it see
// and change that tenant's rows.
export const withTenant = async <T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [tenantId]);
    return await work(client);
  } finally {
    client.release();
  }
};
