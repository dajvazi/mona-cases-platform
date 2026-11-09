import Fastify from 'fastify';
import { caseRoutes } from './cases.js';
import { emailRoutes } from './emails.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

export const buildApp = ({ logger = false }: { logger?: boolean } = {}) => {
  const app = Fastify({ logger });

  // Errors: no database details to the client
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  app.decorateRequest('tenantId', '');

  // Tenant-scoped routes
  app.register(async (api) => {
    // Tenant check, before validation
    api.addHook('onRequest', async (request, reply) => {
      const tenantId = String(request.headers['x-tenant-id'] ?? '');
      if (!UUID.test(tenantId)) return reply.code(401).send({ error: 'missing or invalid x-tenant-id' });
      request.tenantId = tenantId;
    });

    api.register(caseRoutes);
    api.register(emailRoutes);
  });

  return app;
};
