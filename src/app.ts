import Fastify from 'fastify';
import { withTenant } from './tenant.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export const buildApp = () => {
  const app = Fastify({ logger: false });

  // Authentication is out of scope here: the gateway in front of this service sets x-tenant-id after the login.
  app.decorateRequest('tenantId', '');
  app.addHook('preHandler', async (request, reply) => {
    const tenantId = String(request.headers['x-tenant-id'] ?? '');
    if (!UUID.test(tenantId)) return reply.code(401).send({ error: 'missing or invalid x-tenant-id' });
    request.tenantId = tenantId;
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
      const { rows } = await db.query('SELECT * FROM cases WHERE id = $1', [request.params.id]);
      return rows[0];
    });
    return found ?? reply.code(404).send({ error: 'not found' });
  });

  app.post<{ Body: { subject?: string; requester_email?: string } }>('/cases', async (request, reply) => {
    const { subject, requester_email: email } = request.body ?? {};
    if (!subject || !email) return reply.code(400).send({ error: 'subject and requester_email are required' });
    const created = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query(
        `INSERT INTO cases (tenant_id, subject, requester_email) VALUES (current_setting('app.tenant_id')::uuid, $1, $2) RETURNING *`,
        [subject, email],
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
      const { rows } = await db.query('UPDATE cases SET status = $2 WHERE id = $1 RETURNING *', [request.params.id, status]);
      return rows[0];
    });
    return updated ?? reply.code(404).send({ error: 'not found' });
  });

  return app;
};
