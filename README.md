# Cases platform

A small multi-tenant case service: PostgreSQL with row-level security, a Fastify API in TypeScript. This version adds
email ingestion and fixes tenant isolation, which did not hold (see [What I found](#what-i-found)).

## Run it

Needs Node 20.12 or newer and PostgreSQL 16+ (Docker or native).

```sh
docker compose up -d      # PostgreSQL 16 on localhost:5432
npm install
npm run migrate           # as the admin role; also creates the cases_app role the API connects as
npm test                  # 27 tests: isolation and email ingestion
npm run seed              # two demo tenants with fixed ids, for requests.http
npm run dev               # the API on http://localhost:3000
```

The defaults in `src/db.ts` match `docker-compose.yml`. For another database, copy `.env.example` to `.env` (read by
`dev`, `migrate`, `seed` and the tests):

| Variable | Used by | Default |
| --- | --- | --- |
| `DATABASE_URL` | the API | `postgres://cases_app:cases_app@localhost:5432/cases` |
| `ADMIN_DATABASE_URL` | migrations, seed, test setup | `postgres://postgres:postgres@localhost:5432/cases` |

`requests.http` has every endpoint ready to send (REST Client extension).

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
- **Validation with Fastify JSON schemas** on the new routes: required fields, `from` must be an email address,
  header values at most 998 characters (RFC 5322), and the body capped by Fastify's 1 MiB `bodyLimit`. I left the
  existing routes' hand-written checks as they were, to keep the change focused.

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
  `message_id` under two tenants, reading another tenant's thread, a forged cross-tenant attach in SQL).

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

<!-- TODO: rewrite in your own words: what context you gave it, where it helped, what you checked or changed. -->
I worked with Claude Code. I gave it the brief and the starter, and asked it first to explain the system and to look
for why the isolation claim might be false. We confirmed the superuser problem by hand, with `psql` and `curl`, before
writing any code. I reviewed each change. The reintroduce-the-bug check above is how I verified the tests rather than
trusting that they were green, and it caught one test that proved nothing.
