import type { PoolClient } from 'pg';
import { pool } from './db.js';

// One transaction per request, tenant set transaction-local
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
    // Drop a broken connection
    await client.query('ROLLBACK').catch((rollbackError: Error) => (broken = rollbackError));
    throw error;
  } finally {
    client.release(broken);
  }
};
