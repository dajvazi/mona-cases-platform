-- Emails

-- Target for the composite foreign key
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
  -- Idempotency
  CONSTRAINT emails_message_id_key UNIQUE (tenant_id, message_id),
  -- Same-tenant case only
  CONSTRAINT emails_case_fkey FOREIGN KEY (case_id, tenant_id) REFERENCES cases (id, tenant_id)
);

CREATE INDEX emails_by_case ON emails (case_id, received_at);

ALTER TABLE emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON emails
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Grants
GRANT SELECT, INSERT ON emails TO cases_app;
