-- Inbound emails, each attached to the case of its thread.

-- Target for the composite foreign key below. id alone is already unique; this lets an email reference a case
-- together with its tenant.
ALTER TABLE cases ADD CONSTRAINT cases_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  case_id uuid NOT NULL,
  message_id text NOT NULL,
  in_reply_to text,
  from_address text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  -- Each message is stored once per tenant, which makes ingestion idempotent. The same message_id under two tenants
  -- is two separate emails. The index behind this constraint also serves the in_reply_to lookup.
  CONSTRAINT emails_message_id_key UNIQUE (tenant_id, message_id),
  -- An email can only belong to a case of its own tenant. This holds even if application code got it wrong:
  -- foreign key checks don't go through row-level security.
  CONSTRAINT emails_case_fkey FOREIGN KEY (case_id, tenant_id) REFERENCES cases (id, tenant_id)
);

CREATE INDEX emails_by_case ON emails (case_id, received_at);

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON emails
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Emails are append-only for the API.
GRANT SELECT, INSERT ON emails TO cases_app;
