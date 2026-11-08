import Fastify from 'fastify';
import { withTenant } from './tenant.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

// Tenant isolation has two independent layers: row-level security in the database, and an explicit tenant filter in
// every query here. Either one alone keeps tenants apart, so one mistake isn't enough to leak data.
export const buildApp = ({ logger = false }: { logger?: boolean } = {}) => {
  const app = Fastify({ logger });

  // Authentication is out of scope here: the gateway in front of this service sets x-tenant-id after the login.
  app.decorateRequest('tenantId', '');
  app.addHook('preHandler', async (request, reply) => {
    const tenantId = String(request.headers['x-tenant-id'] ?? '');
    if (!UUID.test(tenantId)) return reply.code(401).send({ error: 'missing or invalid x-tenant-id' });
    request.tenantId = tenantId;
  });

  // Unexpected errors are logged in full but reach the client without database details.
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  app.get('/cases', async (request) =>
    withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query('SELECT * FROM cases WHERE tenant_id = $1 ORDER BY created_at DESC', [request.tenantId]);
      return rows;
    }),
  );

  app.get<{ Params: { id: string } }>('/cases/:id', async (request, reply) => {
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });
    const found = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query('SELECT * FROM cases WHERE id = $1 AND tenant_id = $2', [request.params.id, request.tenantId]);
      return rows[0];
    });
    return found ?? reply.code(404).send({ error: 'not found' });
  });

  app.post<{ Body: { subject?: string; requester_email?: string } }>('/cases', async (request, reply) => {
    const { subject, requester_email: email } = request.body ?? {};
    if (!subject || !email) return reply.code(400).send({ error: 'subject and requester_email are required' });
    const created = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query(
        'INSERT INTO cases (tenant_id, subject, requester_email) VALUES ($1, $2, $3) RETURNING *',
        [request.tenantId, subject, email],
      );
      return rows[0];
    });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string }; Body: { status?: string } }>('/cases/:id/status', async (request, reply) => {
    const status = request.body?.status;
    if (!UUID.test(request.params.id)) return reply.code(404).send({ error: 'not found' });
    if (status !== 'open' && status !== 'closed') return reply.code(400).send({ error: 'status must be open or closed' });
    const updated = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query(
        'UPDATE cases SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [request.params.id, request.tenantId, status],
      );
      return rows[0];
    });
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  return app;
};
