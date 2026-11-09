import type { FastifyPluginAsync } from 'fastify';
import { withTenant } from './tenant.js';

export const caseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    tenant_id: { type: 'string', format: 'uuid' },
    subject: { type: 'string' },
    requester_email: { type: 'string' },
    status: { type: 'string', enum: ['open', 'closed'] },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

export const errorSchema = { type: 'object', properties: { error: { type: 'string' } } } as const;

export const caseParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const notFound = { error: 'not found' };

export const caseRoutes: FastifyPluginAsync = async (app) => {
  app.get('/cases', {
    schema: { response: { 200: { type: 'array', items: caseSchema } } },
  }, async (request) =>
    withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query('SELECT * FROM cases WHERE tenant_id = $1 ORDER BY created_at DESC', [request.tenantId]);
      return rows;
    }),
  );

  app.get<{ Params: { id: string } }>('/cases/:id', {
    schema: { params: caseParamsSchema, response: { 200: caseSchema, 404: errorSchema } },
  }, async (request, reply) => {
    const found = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query('SELECT * FROM cases WHERE id = $1 AND tenant_id = $2', [request.params.id, request.tenantId]);
      return rows[0];
    });
    return found ?? reply.code(404).send(notFound);
  });

  app.post<{ Body: { subject: string; requester_email: string } }>('/cases', {
    schema: {
      body: {
        type: 'object',
        required: ['subject', 'requester_email'],
        additionalProperties: false,
        properties: {
          subject: { type: 'string', minLength: 1, maxLength: 998 },
          requester_email: { type: 'string', format: 'email', maxLength: 320 },
        },
      },
      response: { 201: caseSchema },
    },
  }, async (request, reply) => {
    const created = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query(
        'INSERT INTO cases (tenant_id, subject, requester_email) VALUES ($1, $2, $3) RETURNING *',
        [request.tenantId, request.body.subject, request.body.requester_email],
      );
      return rows[0];
    });
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string }; Body: { status: 'open' | 'closed' } }>('/cases/:id/status', {
    schema: {
      params: caseParamsSchema,
      body: {
        type: 'object',
        required: ['status'],
        additionalProperties: false,
        properties: { status: { type: 'string', enum: ['open', 'closed'] } },
      },
      response: { 200: caseSchema, 404: errorSchema },
    },
  }, async (request, reply) => {
    const updated = await withTenant(request.tenantId, async (db) => {
      const { rows } = await db.query(
        'UPDATE cases SET status = $3 WHERE id = $1 AND tenant_id = $2 RETURNING *',
        [request.params.id, request.tenantId, request.body.status],
      );
      return rows[0];
    });
    return updated ?? reply.code(404).send(notFound);
  });
};
