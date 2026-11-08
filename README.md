# Cases platform

A small multi-tenant case service: PostgreSQL with row-level security, a Fastify API in TypeScript.

## Run it

Needs Node 20 or newer and Docker.

```sh
docker compose up -d      # PostgreSQL 16 on localhost:5432
npm install
npm run migrate
npm run dev               # the API on http://localhost:3000
npm test                  # the isolation tests
```

Every request carries `x-tenant-id` (the gateway sets it after login).

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/cases` | The tenant's cases, newest first |
| GET | `/cases/:id` | One case |
| POST | `/cases` | Opens a case: `{ subject, requester_email }` |
| PATCH | `/cases/:id/status` | `{ status: "open" \| "closed" }` |

## Handover note

Tenant isolation is done and covered by tests, all green. Every case belongs to a tenant, and the `tenant_isolation`
policy on `cases` makes sure a tenant only ever sees and changes its own rows. `withTenant` (`src/tenant.ts`) sets the
tenant on the connection before any query runs. CI runs the tests on every push.
