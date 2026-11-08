import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { ADMIN_DATABASE_URL } from './db.js';

// Applies every migration in migrations/ that hasn't been applied yet, in name order. Runs as the admin role: the
// migrations create tables, policies and the role the API connects as.
export const migrate = async (admin: pg.Pool) => {
  await admin.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await admin.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
  const dir = new URL('../migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter((file) => file.endsWith('.sql')).sort()) {
    if (done.has(name)) continue;
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(new URL(name, dir), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const admin = new pg.Pool({ connectionString: ADMIN_DATABASE_URL, max: 1 });
  try {
    await migrate(admin);
  } finally {
    await admin.end();
  }
}
