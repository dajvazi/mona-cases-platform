import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

// OpenAPI document built from the routes' JSON schemas, served at /docs/json, with Swagger UI at /docs. The
// "Authorize" button sets x-tenant-id once for every request sent from the page.
export const registerDocs = (app: FastifyInstance) => {
  app.register(swagger, {
    openapi: {
      info: {
        title: 'Cases platform',
        version: '1.0.0',
        description: 'Multi-tenant case service. Every request is scoped to the tenant in the x-tenant-id header.',
      },
      components: {
        securitySchemes: {
          tenant: {
            type: 'apiKey',
            in: 'header',
            name: 'x-tenant-id',
            description: 'Tenant id (UUID). The gateway sets it after login; `npm run seed` creates two demo tenants.',
          },
        },
      },
      security: [{ tenant: [] }],
    },
  });
  app.register(swaggerUi, { routePrefix: '/docs' });
};
