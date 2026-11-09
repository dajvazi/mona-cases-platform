-- API role and RLS fixes

-- Current tenant, NULL when unset
CREATE FUNCTION public.app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DROP POLICY tenant_isolation ON cases;
CREATE POLICY tenant_isolation ON cases
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Force RLS
ALTER TABLE cases FORCE ROW LEVEL SECURITY;

-- API role (local/CI password)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cases_app') THEN
    CREATE ROLE cases_app LOGIN PASSWORD 'cases_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Grants
GRANT USAGE ON SCHEMA public TO cases_app;
GRANT SELECT, INSERT, UPDATE ON cases TO cases_app;
