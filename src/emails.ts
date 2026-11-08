import type { FastifyPluginAsync } from 'fastify';
import type { PoolClient } from 'pg';
import { caseParamsSchema, errorSchema } from './cases.js';
import { withTenant } from './tenant.js';

// A parsed inbound email, as the mail pipeline hands it over.
export interface InboundEmail {
  message_id: string;
  in_reply_to?: string | null;
  from: string;
  subject: string;
  body: string;
}

export interface IngestResult {
  email_id: string;
  case_id: string;
  created_case: boolean;
  duplicate: boolean;
}

// 998 is the longest line RFC 5322 allows, so no valid header value is longer.
const inboundEmailSchema = {
  type: 'object',
  required: ['message_id', 'from', 'subject', 'body'],
  additionalProperties: false,
  properties: {
    message_id: { type: 'string', maxLength: 998, pattern: '\\S' },
    in_reply_to: { type: ['string', 'null'], maxLength: 998 },
    from: { type: 'string', format: 'email', maxLength: 320 },
    subject: { type: 'string', maxLength: 998 },
    body: { type: 'string' }, // capped by Fastify's bodyLimit (1 MiB by default)
  },
} as const;

const ingestResultSchema = {
  type: 'object',
  properties: {
    email_id: { type: 'string', format: 'uuid' },
    case_id: { type: 'string', format: 'uuid' },
    created_case: { type: 'boolean' },
    duplicate: { type: 'boolean' },
  },
} as const;

const emailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    message_id: { type: 'string' },
    in_reply_to: { type: ['string', 'null'] },
    from_address: { type: 'string' },
    subject: { type: 'string' },
    body: { type: 'string' },
    received_at: { type: 'string', format: 'date-time' },
  },
} as const;

const NO_SUBJECT = '(no subject)';

const findEmail = async (db: PoolClient, tenantId: string, messageId: string) => {
  const { rows } = await db.query<{ id: string; case_id: string }>(
    'SELECT id, case_id FROM emails WHERE tenant_id = $1 AND message_id = $2',
    [tenantId, messageId],
  );
  return rows[0];
};

const openCase = async (db: PoolClient, tenantId: string, email: InboundEmail) => {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO cases (tenant_id, subject, requester_email) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, email.subject.trim() || NO_SUBJECT, email.from],
  );
  return rows[0].id;
};

// Stores an email on the case of its thread, or on a new case when it doesn't reply to a known email. An email that
// was already stored is not stored again. Has to run inside withTenant, so all of it is one transaction.
export const ingestEmail = async (db: PoolClient, tenantId: string, email: InboundEmail): Promise<IngestResult> => {
  // Mail pipelines retry, so the same message can arrive twice at the same moment. This lock makes concurrent
  // deliveries of one message (per tenant) wait for each other until the first one commits, so the check below sees
  // it. The unique constraint on (tenant_id, message_id) stays the hard guarantee.
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, email.message_id]);

  const existing = await findEmail(db, tenantId, email.message_id);
  if (existing) return { email_id: existing.id, case_id: existing.case_id, created_case: false, duplicate: true };

  // The lookup is scoped to the tenant, so replying to another tenant's message_id opens a new case instead.
  const parent = email.in_reply_to ? await findEmail(db, tenantId, email.in_reply_to) : undefined;
  const caseId = parent?.case_id ?? (await openCase(db, tenantId, email));

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO emails (tenant_id, case_id, message_id, in_reply_to, from_address, subject, body)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [tenantId, caseId, email.message_id, email.in_reply_to ?? null, email.from, email.subject, email.body],
  );
  return { email_id: rows[0].id, case_id: caseId, created_case: !parent, duplicate: false };
};

// Message IDs are compared exactly, so stray whitespace from the parser would break threading and deduplication.
const normalize = (email: InboundEmail): InboundEmail => ({
  ...email,
  message_id: email.message_id.trim(),
  in_reply_to: email.in_reply_to?.trim() || null,
});

export const emailRoutes: FastifyPluginAsync = async (app) => {
  // 201 when the email was stored, 200 when it had been stored before (so a retrying sender can treat both as done).
  app.post<{ Body: InboundEmail }>('/emails', {
    schema: {
      tags: ['emails'],
      summary: 'Ingests a parsed email into the case of its thread, or a new case',
      body: inboundEmailSchema,
      response: { 200: ingestResultSchema, 201: ingestResultSchema },
    },
  }, async (request, reply) => {
    const email = normalize(request.body);
    const result = await withTenant(request.tenantId, (db) => ingestEmail(db, request.tenantId, email));
    return reply.code(result.duplicate ? 200 : 201).send(result);
  });

  app.get<{ Params: { id: string } }>('/cases/:id/emails', {
    schema: {
      tags: ['emails'],
      summary: 'The emails of a case, oldest first',
      params: caseParamsSchema,
      response: { 200: { type: 'array', items: emailSchema }, 404: errorSchema },
    },
  }, async (request, reply) => {
    const emails = await withTenant(request.tenantId, async (db) => {
      const found = await db.query('SELECT 1 FROM cases WHERE id = $1 AND tenant_id = $2', [request.params.id, request.tenantId]);
      if (found.rowCount === 0) return undefined;
      const { rows } = await db.query(
        `SELECT id, message_id, in_reply_to, from_address, subject, body, received_at
         FROM emails WHERE case_id = $1 AND tenant_id = $2 ORDER BY received_at, id`,
        [request.params.id, request.tenantId],
      );
      return rows;
    });
    return emails ?? reply.code(404).send({ error: 'not found' });
  });
};
