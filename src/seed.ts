import pg from 'pg';
import { ADMIN_DATABASE_URL } from './db.js';

// Two tenants with fixed ids for trying the API by hand (requests.http). `npm test` empties the tables, so run this
// again after the tests.
export const DEMO_TENANTS = {
  'Tenant A': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Tenant B': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

const admin = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
try {
  for (const [name, id] of Object.entries(DEMO_TENANTS)) {
    await admin.query('INSERT INTO tenants (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [id, name]);
    console.log(`${name}: ${id}`);
  }
} finally {
  await admin.end();
}
