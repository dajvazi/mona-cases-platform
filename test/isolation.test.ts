import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const app = buildApp();
let tenantA = '';
let tenantB = '';

const as = (tenantId: string) => ({ 'x-tenant-id': tenantId });

beforeAll(async () => {
  await migrate();
  await pool.query('TRUNCATE cases, tenants');
  ({ rows: [{ id: tenantA }] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Tenant A') RETURNING id`));
  ({ rows: [{ id: tenantB }] } = await pool.query(`INSERT INTO tenants (name) VALUES ('Tenant B') RETURNING id`));
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('tenant isolation', () => {
  it('has row-level security enabled on cases', async () => {
    const { rows } = await pool.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'cases'`);
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it('has the tenant_isolation policy on cases', async () => {
    const { rows } = await pool.query(`SELECT policyname FROM pg_policies WHERE tablename = 'cases'`);
    expect(rows.map((row) => row.policyname)).toContain('tenant_isolation');
  });

  it('creates a case for the calling tenant only', async () => {
    const response = await app.inject({ method: 'POST', url: '/cases', headers: as(tenantA), payload: { subject: 'Heating', requester_email: 'a@example.com' } });
    expect(response.statusCode).toBe(201);
    expect(response.json().tenant_id).toBe(tenantA);
  });

  it('lists only the calling tenant\'s cases', async () => {
    await app.inject({ method: 'POST', url: '/cases', headers: as(tenantB), payload: { subject: 'Lift', requester_email: 'b@example.com' } });
    const listA = (await app.inject({ method: 'GET', url: '/cases', headers: as(tenantA) })).json();
    const listB = (await app.inject({ method: 'GET', url: '/cases', headers: as(tenantB) })).json();
    expect(listA.every((c: { tenant_id: string }) => c.tenant_id === tenantA)).toBe(true);
    expect(listB.every((c: { tenant_id: string }) => c.tenant_id === tenantB)).toBe(true);
    expect(listA).toHaveLength(1);
    expect(listB).toHaveLength(1);
  });

  it('rejects requests without a tenant', async () => {
    const response = await app.inject({ method: 'GET', url: '/cases' });
    expect(response.statusCode).toBe(401);
  });
});
