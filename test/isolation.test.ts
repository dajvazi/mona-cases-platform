import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { withTenant } from '../src/tenant.js';
import { admin, as, createTenant, resetDatabase } from './helpers.js';

const app = buildApp();
let tenantA = '';
let tenantB = '';

beforeAll(async () => {
  await resetDatabase();
  tenantA = await createTenant('Tenant A');
  tenantB = await createTenant('Tenant B');
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});

const openCase = async (tenantId: string, subject: string) =>
  (await app.inject({ method: 'POST', url: '/cases', headers: as(tenantId), payload: { subject, requester_email: 'someone@example.com' } })).json();

describe('tenant isolation through the API', () => {
  it('creates a case for the calling tenant only', async () => {
    const response = await app.inject({ method: 'POST', url: '/cases', headers: as(tenantA), payload: { subject: 'Heating', requester_email: 'a@example.com' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().tenant_id).toBe(tenantA);
  });

  it('lists only the calling tenant\'s cases', async () => {
    await openCase(tenantB, 'Lift');
    const listA = (await app.inject({ method: 'GET', url: '/cases', headers: as(tenantA) })).json();
    const listB = (await app.inject({ method: 'GET', url: '/cases', headers: as(tenantB) })).json();
    expect(listA.map((c: { subject: string }) => c.subject)).toEqual(['Heating']);
    expect(listB.map((c: { subject: string }) => c.subject)).toEqual(['Lift']);
  });

  it('does not let a tenant read another tenant\'s case by id', async () => {
    const caseOfA = await openCase(tenantA, 'Boiler');
    const response = await app.inject({ method: 'GET', url: `/cases/${caseOfA.id}`, headers: as(tenantB) });
    expect(response.statusCode).toBe(404);
  });

  it('does not let a tenant change another tenant\'s case', async () => {
    const caseOfA = await openCase(tenantA, 'Roof');
    const response = await app.inject({ method: 'PATCH', url: `/cases/${caseOfA.id}/status`, headers: as(tenantB), payload: { status: 'closed' } });
    expect(response.statusCode).toBe(404);
    const { rows } = await admin.query('SELECT status FROM cases WHERE id = $1', [caseOfA.id]);
    expect(rows[0].status).toBe('open');
  });

  it('rejects requests without a tenant', async () => {
    const response = await app.inject({ method: 'GET', url: '/cases' });
    expect(response.statusCode).toBe(401);
  });
});

// These go around the API's own tenant filters, so they show that the database keeps tenants apart by itself.
describe('tenant isolation in the database', () => {
  it('shows a tenant only its own rows even when a query has no tenant filter', async () => {
    const tenants = await withTenant(tenantB, async (db) => (await db.query('SELECT DISTINCT tenant_id FROM cases')).rows);
    expect(tenants).toEqual([{ tenant_id: tenantB }]);
  });

  it('refuses to write a row for another tenant', async () => {
    const write = withTenant(tenantB, (db) =>
      db.query(`INSERT INTO cases (tenant_id, subject, requester_email) VALUES ($1, 'Sneaky', 'b@example.com')`, [tenantA]),
    );
    await expect(write).rejects.toThrow(/row-level security/);
  });

  it('shows nothing to a query that runs without a tenant', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM cases');
    expect(rows[0].count).toBe(0);
  });

  it('does not leave the tenant on a pooled connection after the request', async () => {
    const usedPid = await withTenant(tenantA, async (db) => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    const client = await pool.connect();
    try {
      const { rows } = await client.query(`SELECT pg_backend_pid() AS pid, (SELECT count(*)::int FROM cases) AS count`);
      expect(rows[0].pid).toBe(usedPid); // the pool handed back the same connection
      expect(rows[0].count).toBe(0);
    } finally {
      client.release();
    }
  });

  it('connects the API as a role that row-level security applies to', async () => {
    const { rows } = await pool.query(
      `SELECT rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_class WHERE relowner = pg_roles.oid) AS owned
       FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it('has forced row-level security and a policy on every table with a tenant_id', async () => {
    const { rows } = await admin.query(
      `SELECT c.relname AS table, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
       WHERE c.relkind IN ('r', 'p')
       ORDER BY c.relname`,
    );
    expect(rows.map((row) => row.table)).toEqual(expect.arrayContaining(['cases']));
    for (const row of rows) expect(row, row.table).toMatchObject({ enabled: true, forced: true, policies: 1 });
  });
});
