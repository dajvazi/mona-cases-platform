import pg from 'pg';
import { ADMIN_DATABASE_URL } from '../src/db.js';
import { migrate } from '../src/migrate.js';

// Test setup (migrating, truncating, creating tenants) needs the admin role; everything under test goes through the
// API or the app's own pool, so it runs as cases_app with row-level security in force.
export const admin = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 2 });

export const resetDatabase = async () => {
  await migrate(admin);
  await admin.query('TRUNCATE emails, cases, tenants');
};

export const createTenant = async (name: string): Promise<string> =>
  (await admin.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id', [name])).rows[0].id;

export const as = (tenantId: string) => ({ 'x-tenant-id': tenantId });
