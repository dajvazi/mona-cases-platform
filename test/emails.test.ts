import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db.js';
import { ingestEmail, type InboundEmail } from '../src/emails.js';
import { withTenant } from '../src/tenant.js';
import { admin, as, createTenant, resetDatabase } from './helpers.js';

const app = buildApp();
let tenantA = '';
let tenantB = '';

beforeAll(async () => {
  await resetDatabase();
  tenantA = await createTenant('Tenant A');
  tenantB = await createTenant('Tenant B');
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.end();
});

let sequence = 0;
// A unique message_id per call keeps tests independent of each other.
const email = (overrides: Partial<InboundEmail> = {}): InboundEmail => ({
  message_id: `<${++sequence}.${Date.now()}@mail.example.com>`,
  in_reply_to: null,
  from: 'resident@example.com',
  subject: 'Heating is broken',
  body: 'Since this morning.',
  ...overrides,
});

const ingest = (tenantId: string, payload: object) => app.inject({ method: 'POST', url: '/emails', headers: as(tenantId), payload });

const emailsOf = async (tenantId: string, caseId: string) =>
  app.inject({ method: 'GET', url: `/cases/${caseId}/emails`, headers: as(tenantId) });

const countRows = async (table: 'cases' | 'emails', tenantId: string) =>
  (await admin.query(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].count;

const waitUntilWaitingOnLock = async (pid: number) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await admin.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`connection ${pid} never waited on a lock`);
};

describe('POST /emails', () => {
  it('opens a new case for an email that starts a thread', async () => {
    const response = await ingest(tenantA, email({ from: 'anna@example.com', subject: 'Lift stuck' }));
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result).toMatchObject({ created_case: true, duplicate: false });

    const opened = (await app.inject({ method: 'GET', url: `/cases/${result.case_id}`, headers: as(tenantA) })).json();
    expect(opened).toMatchObject({ subject: 'Lift stuck', requester_email: 'anna@example.com', status: 'open' });
  });

  it('adds replies, and replies to replies, to the case of their thread', async () => {
    const first = email();
    const opened = (await ingest(tenantA, first)).json();
    const reply = email({ in_reply_to: first.message_id, subject: 'Re: Heating is broken' });
    const replyResult = (await ingest(tenantA, reply)).json();
    const replyToReply = (await ingest(tenantA, email({ in_reply_to: reply.message_id }))).json();

    expect(replyResult).toMatchObject({ case_id: opened.case_id, created_case: false });
    expect(replyToReply).toMatchObject({ case_id: opened.case_id, created_case: false });
    const thread = (await emailsOf(tenantA, opened.case_id)).json();
    expect(thread.map((e: { message_id: string }) => e.message_id)).toEqual([first.message_id, reply.message_id, expect.any(String)]);
  });

  it('opens a new case when in_reply_to points to an email it has never seen', async () => {
    const response = await ingest(tenantA, email({ in_reply_to: '<unknown@mail.example.com>' }));
    expect(response.statusCode).toBe(201);
    expect(response.json().created_case).toBe(true);
  });

  it('ignores an email it has already seen', async () => {
    const message = email();
    const first = (await ingest(tenantA, message)).json();
    const casesBefore = await countRows('cases', tenantA);

    const again = await ingest(tenantA, message);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ ...first, created_case: false, duplicate: true });
    expect(await countRows('cases', tenantA)).toBe(casesBefore);
    expect((await emailsOf(tenantA, first.case_id)).json()).toHaveLength(1);
  });

  // Firing parallel requests doesn't reliably overlap them (that version of this test passed without the lock), so
  // this one interleaves two transactions by hand: the second delivery starts while the first is still uncommitted.
  it('makes a second delivery of the same message wait for the first and then report a duplicate', async () => {
    const message = email();
    const [first, second] = [await pool.connect(), await pool.connect()];
    try {
      for (const client of [first, second]) {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      }
      const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      const firstResult = await ingestEmail(first, tenantA, message);
      const secondResult = ingestEmail(second, tenantA, message);
      await waitUntilWaitingOnLock(secondPid);
      await first.query('COMMIT');

      await expect(secondResult).resolves.toMatchObject({ duplicate: true, case_id: firstResult.case_id });
      await second.query('COMMIT');
      const { rows } = await admin.query(
        'SELECT count(*)::int AS count FROM cases c WHERE NOT EXISTS (SELECT FROM emails e WHERE e.case_id = c.id)',
      );
      expect(rows[0].count).toBe(0); // the second delivery didn't leave an empty case behind
    } finally {
      for (const client of [first, second]) {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });

  it('treats message ids with surrounding whitespace as the same message', async () => {
    const message = email();
    const first = (await ingest(tenantA, message)).json();
    const padded = await ingest(tenantA, { ...message, message_id: `  ${message.message_id}\n` });
    expect(padded.json()).toMatchObject({ case_id: first.case_id, duplicate: true });
  });

  it('gives a case a placeholder subject when the email has none', async () => {
    const result = (await ingest(tenantA, email({ subject: '' }))).json();
    const opened = (await app.inject({ method: 'GET', url: `/cases/${result.case_id}`, headers: as(tenantA) })).json();
    expect(opened.subject).toBe('(no subject)');
  });

  it.each([
    ['message_id is missing', { message_id: undefined }],
    ['message_id is blank', { message_id: '   ' }],
    ['from is not an email address', { from: 'not an address' }],
    ['body is missing', { body: undefined }],
  ])('rejects the email when %s', async (_, overrides) => {
    const response = await ingest(tenantA, { ...email(), ...overrides });
    expect(response.statusCode).toBe(400);
  });

  it('rejects requests without a tenant', async () => {
    const response = await app.inject({ method: 'POST', url: '/emails', payload: email() });
    expect(response.statusCode).toBe(401);
  });
});

describe('email ingestion keeps tenants apart', () => {
  it('opens a new case instead of attaching to another tenant\'s thread', async () => {
    const original = email();
    const caseOfA = (await ingest(tenantA, original)).json().case_id;

    const response = await ingest(tenantB, email({ in_reply_to: original.message_id }));
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result.created_case).toBe(true);
    expect(result.case_id).not.toBe(caseOfA);

    expect((await emailsOf(tenantA, caseOfA)).json()).toHaveLength(1);
    const { rows } = await admin.query('SELECT tenant_id FROM cases WHERE id = $1', [result.case_id]);
    expect(rows[0].tenant_id).toBe(tenantB);
  });

  it('does not treat another tenant\'s message_id as a duplicate', async () => {
    const message = email();
    const resultA = (await ingest(tenantA, message)).json();
    const responseB = await ingest(tenantB, message);
    expect(responseB.statusCode).toBe(201);
    expect(responseB.json()).toMatchObject({ duplicate: false, created_case: true });
    expect(responseB.json().case_id).not.toBe(resultA.case_id);
  });

  it('does not show a tenant the emails of another tenant\'s case', async () => {
    const caseOfA = (await ingest(tenantA, email())).json().case_id;
    expect((await emailsOf(tenantB, caseOfA)).statusCode).toBe(404);
  });

  it('cannot attach an email to another tenant\'s case even if the code tried to', async () => {
    const caseOfA = (await ingest(tenantA, email())).json().case_id;
    const write = withTenant(tenantB, (db) =>
      db.query(
        `INSERT INTO emails (tenant_id, case_id, message_id, from_address, subject, body)
         VALUES ($1, $2, '<forged@mail.example.com>', 'b@example.com', 'x', 'x')`,
        [tenantB, caseOfA],
      ),
    );
    await expect(write).rejects.toThrow(/emails_case_fkey/);
  });
});
