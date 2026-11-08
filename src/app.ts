import Fastify from 'fastify';
import { caseRoutes } from './cases.js';
import { registerDocs } from './docs.js';
import { emailRoutes } from './emails.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string;
  }
}

// Tenant isolation has two independent layers: row-level security in the database, and an explicit tenant filter in
// every query. Either one alone keeps tenants apart, so one mistake isn't enough to leak data.
export const buildApp = ({ logger = false, docs = false }: { logger?: boolean; docs?: boolean } = {}) => {
  const app = Fastify({ logger });

  // Unexpected errors are logged in full but reach the client without database details.
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      request.log.error(error);
      return reply.code(500).send({ error: 'internal server error' });
    }
    return reply.code(statusCode).send({ error: error.message });
  });

  // Registered outside the API plugin below, so the docs don't need a tenant; the API routes still do.
  if (docs) registerDocs(app);

  app.decorateRequest('tenantId', '');

  // Everything tenant-scoped lives in this plugin. Fastify encapsulation applies the hook to these routes only, which
  // avoids exempting paths by URL.
  app.register(async (api) => {
    // Authentication is out of scope here: the gateway in front of this service sets x-tenant-id after the login.
    // onRequest runs before body validation, so a request without a tenant learns nothing about the API.
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
