# Cases platform

A small multi-tenant case service: PostgreSQL with row-level security, a Fastify API in TypeScript. This version adds
email ingestion and fixes tenant isolation, which did not hold (see [What I found](#what-i-found)).

## Run it

Needs Node 20.12 or newer and PostgreSQL 16+ (Docker or native).

```sh
docker compose up -d      # PostgreSQL 16 on localhost:5432
npm install
npm run migrate           # as the admin role; also creates the cases_app role the API connects as
npm test                  # 31 tests: isolation, email ingestion, API docs
npm run seed              # two demo tenants with fixed ids, for Swagger UI and requests.http
npm run dev               # the API on http://localhost:3000, Swagger UI on http://localhost:3000/docs
```

The defaults in `src/db.ts` match `docker-compose.yml`. For another database, copy `.env.example` to `.env` (read by
`dev`, `migrate`, `seed` and the tests):

| Variable | Used by | Default |
| --- | --- | --- |
| `DATABASE_URL` | the API | `postgres://cases_app:cases_app@localhost:5432/cases` |
| `ADMIN_DATABASE_URL` | migrations, seed, test setup | `postgres://postgres:postgres@localhost:5432/cases` |

To try the API by hand, open **http://localhost:3000/docs**, click **Authorize** and enter a tenant id from
`npm run seed` (`aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` or `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`). Every request sent
from the page then carries it as `x-tenant-id`. `requests.http` has the same requests as a script, for the REST Client
extension.

## API

Every request carries `x-tenant-id` (the gateway sets it after login).

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/cases` | The tenant's cases, newest first |
| GET | `/cases/:id` | One case |
| POST | `/cases` | Opens a case: `{ subject, requester_email }` |
| PATCH | `/cases/:id/status` | `{ status: "open" \| "closed" }` |
| **POST** | **`/emails`** | Ingests a parsed email: `{ message_id, in_reply_to?, from, subject, body }` |
| **GET** | **`/cases/:id/emails`** | The emails of a case, oldest first |

`POST /emails` answers `201 { email_id, case_id, created_case, duplicate: false }` when it stored the email, and
`200 { ..., duplicate: true }` with the original ids when it had seen that `message_id` before.

## What I found

The handover note says tenant isolation is done and tested. It wasn't. Before changing anything I added two tests
(tenant B reads, then closes, tenant A's case by id); both failed with `200` where `404` was expected.

1. **The API connected as `postgres`, a superuser.** Superusers skip row-level security, so the `tenant_isolation`
   policy was never evaluated for any request. `GET /cases/:id` and `PATCH /cases/:id/status` had no tenant filter of
   their own, so any tenant could read and change any case whose id it knew.
2. **The tests were green for the wrong reasons.** They checked that RLS was *enabled* and that the policy *existed*,
   not that it filtered anything. The list test passed only because `GET /cases` has its own `WHERE tenant_id = $1`.
   That filter hid the problem.
3. **`withTenant` set the tenant for the whole session** (`set_config(..., false)`) on pooled connections. The setting
   stayed on the connection after the request, so any query run on it without `withTenant` would act as the previous
   request's tenant.
4. Smaller: with no tenant set, the policy could fail with a cast error (`''::uuid`) instead of matching no rows, and
   unexpected errors were returned to the client with the raw database message.

## Decisions

- **A separate role for the API.** `002_app_role.sql` creates `cases_app`: no superuser, no `BYPASSRLS`, owns
  nothing, and only `SELECT/INSERT/UPDATE` on `cases` and `SELECT/INSERT` on `emails` (no `DELETE`, nothing on
  `tenants`). Migrations run as the admin role. `FORCE ROW LEVEL SECURITY` makes policies apply to the table owner too.
  I added new migrations instead of editing `001`, since an applied migration shouldn't change.
- **A transaction per request.** `withTenant` now runs `BEGIN`, `set_config(..., true)`, the work, then `COMMIT`. The
  tenant disappears when the transaction ends, so connections go back to the pool clean. A query without `withTenant`
  sees no rows. Email ingestion needs the transaction anyway.
- **Isolation in depth.** Row-level security is the guarantee, and every query still filters by tenant explicitly.
  Emails reference their case through a composite foreign key `(case_id, tenant_id) → cases (id, tenant_id)`, so the
  database refuses to attach an email to another tenant's case even if the code tried.
- **Idempotency in the database.** `UNIQUE (tenant_id, message_id)`: the same message is stored once per tenant, and
  the same `message_id` under two tenants is two separate emails. Concurrent deliveries of one message are serialized
  with a transaction-scoped advisory lock on `(tenant, message_id)`. Without it, two retries arriving together would
  both open a case and one would then fail on the unique constraint. I chose the lock over "insert, catch the conflict,
  roll back and re-read" because it keeps the flow linear and readable. The unique constraint is still the hard
  guarantee.
- **Threading** looks up `in_reply_to` among the tenant's own emails. If there's no match (unknown parent, another
  tenant's message, or a reply that arrives before its parent), a new case opens. Message ids are trimmed, because
  stray whitespace from a parser would break both threading and deduplication. An empty subject becomes
  `(no subject)`.
- **Fastify JSON schemas on every route.** One schema does three jobs: it validates the request (required fields,
  email addresses, ids that are UUIDs, header values at most 998 characters per RFC 5322, the body capped by the
  1 MiB `bodyLimit`), it filters the response to the listed fields, and it generates the OpenAPI document behind
  Swagger UI. The hand-written checks on the case routes are gone. One visible change: a malformed case id now gets
  `400` instead of `404`.
- **Code layout.** `app.ts` only assembles the app. Case routes are in `cases.ts`, email routes and ingestion in
  `emails.ts`, Swagger in `docs.ts`. The tenant check is an `onRequest` hook inside an encapsulated plugin holding all
  tenant-scoped routes. Swagger UI sits outside that plugin, so it needs no tenant, without exempting any path by URL
  (a common way such checks get bypassed). `onRequest` instead of the original `preHandler`: with schemas in place, a
  `preHandler` check would run after validation, and a request without a tenant would get a `400` that describes the
  API.
- **API docs are on in `npm run dev`** (`buildApp({ docs: true })`). In production I'd keep them off or behind the
  gateway's authentication.

## Tenant isolation: how it works and how it could fail

Every tenant-owned table (`cases`, `emails`) has a `tenant_id` and a `tenant_isolation` policy: a row is visible and
writable only when its `tenant_id` equals `app_current_tenant()`, which reads `app.tenant_id` from the current
transaction. The API connects as `cases_app`, a role the policies apply to. For each request, `withTenant` opens a
transaction and sets `app.tenant_id` from the `x-tenant-id` header. Tables use `FORCE ROW LEVEL SECURITY`. On top of
that, the application filters every query by tenant, and the composite foreign key keeps emails on cases of their own
tenant. Each of these layers is tested on its own: the database tests deliberately run queries *without* a tenant
filter, so the application's filter can't hide a broken policy again.

How it could fail:

- **Connecting with the wrong role.** A superuser, a role with `BYPASSRLS`, or the table owner without `FORCE` skips
  every policy. This is exactly how it was broken. A test asserts the API's role has none of these.
- **A new table without RLS.** A test fails if any table with a `tenant_id` lacks enabled and forced RLS and a policy.
  A table that relates to tenants only indirectly (no `tenant_id` column) would slip past that check.
- **Session-level tenant settings.** `set_config(..., false)` or `SET` instead of `SET LOCAL` leaks a tenant across
  pooled connections. The same applies to pgBouncer in transaction mode with session settings.
- **`SECURITY DEFINER` functions and views** run as their owner and skip the caller's policies.
- **Trusting `x-tenant-id`.** The service takes the header at face value. If anything can reach it without going
  through the gateway, or the gateway passes a client-supplied header through, isolation is gone at the front door.
- **Admin paths.** Migrations, scripts or reporting that use the admin role see everything by design. They must never
  serve tenant requests.

## Tests

- `test/isolation.test.ts`: through the API (cross-tenant read, update and list) and directly in the database
  (unfiltered queries, cross-tenant writes, no tenant set, a reused pool connection, the API role's attributes, the
  RLS coverage check).
- `test/emails.test.ts`: new case, replies and replies to replies, unknown parent, duplicates, concurrent duplicates,
  whitespace in ids, empty subject, validation, and isolation (replying to another tenant's `message_id`, the same
  `message_id` under two tenants, reading another tenant's thread, a forged cross-tenant attach in SQL), and that the
  tenant is checked before the body is validated.
- `test/docs.test.ts`: the OpenAPI document and Swagger UI are served without a tenant, and the API still requires one.

To check that the tests actually catch the bugs, I reintroduced each one and ran the suite. Connecting as superuser
fails 5 tests, a session-wide `set_config` fails 2, and removing the advisory lock fails the concurrency test. The
first version of that concurrency test fired parallel requests and **passed without the lock**, because the requests
never actually overlapped. I replaced it with one that interleaves two transactions by hand.

## Not done / next steps

- Threading uses only `In-Reply-To`. Real clients also send `References` (the whole chain), which would thread replies
  whose direct parent is missing.
- A reply to a closed case is added to it but doesn't reopen it. That's a product decision.
- An unknown tenant id (valid UUID, no tenant row) fails on the foreign key and returns `500`. A `404` or `403` would
  be clearer, but authentication is the gateway's job.
- The CI workflow sits in `.github/` here, so it runs when this folder is the repository root.

## How I used AI

I used Claude Code throughout. I started by giving it the brief and the starter and asking it to explain how the pieces
fit together — the RLS policy, `withTenant`, the connection pool — and to treat the handover note as a claim to check
rather than a fact. That framing is what surfaced the real problem: the policy itself was fine, but the role the API
connected as (`postgres`, a superuser) made it irrelevant.

From there I worked in small steps and reviewed each one. The commit history shows the order: a failing test first
(tenant B reading and then closing tenant A's case), then the role and transaction-scoping fixes, then email ingestion.
I didn't take green tests at face value — I put each bug back and checked that the suite actually went red. That is how
I caught a concurrency test that was passing for the wrong reason: it fired parallel requests that never really
overlapped, so I rewrote it to interleave two transactions by hand.

Where a suggestion wasn't clear to me I asked for the reasoning before keeping it, and I dropped the parts that weren't
worth the added complexity for a task this size. The decisions in this file are ones I understand and can walk through.
