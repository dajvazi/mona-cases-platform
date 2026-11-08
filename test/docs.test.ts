import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';

const app = buildApp({ docs: true });

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('API docs', () => {
  it('serves the OpenAPI document without a tenant', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(response.statusCode).toBe(200);
    const spec = response.json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/cases', '/cases/{id}', '/cases/{id}/status', '/emails', '/cases/{id}/emails']),
    );
    expect(spec.components.securitySchemes.tenant).toMatchObject({ type: 'apiKey', in: 'header', name: 'x-tenant-id' });
  });

  it('serves Swagger UI without a tenant', async () => {
    const response = await app.inject({ method: 'GET', url: '/docs' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('swagger-ui');
  });

  it('still requires a tenant on the API when the docs are on', async () => {
    const response = await app.inject({ method: 'GET', url: '/cases' });
    expect(response.statusCode).toBe(401);
  });
});
