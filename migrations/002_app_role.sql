-- Makes the row-level security from 001 actually apply to the API.
--
-- Until now the API connected as `postgres`, a superuser, and superusers skip row-level security entirely, so the
-- tenant_isolation policy was never evaluated for any request. Migrations keep running as an admin role; the API now
-- connects as cases_app, which owns nothing, can't bypass row-level security and only gets the grants it needs.

-- The tenant of the current transaction (set by withTenant), or NULL when none is set. nullif matters: after a
-- transaction-local set_config has ended, the setting reads as '' rather than NULL, and ''::uuid would raise an error
-- instead of matching no rows.
CREATE FUNCTION public.app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

DROP POLICY tenant_isolation ON cases;
CREATE POLICY tenant_isolation ON cases
  USING (tenant_id = public.app_current_tenant())
  WITH CHECK (tenant_id = public.app_current_tenant());

-- Without FORCE, the owner of the table skips its policies too.
ALTER TABLE cases FORCE ROW LEVEL SECURITY;

-- The role the API connects as. Roles are cluster-wide, hence the existence check. The password is a local and CI
-- default only: in production the role is provisioned with a secret and this block leaves it alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'cases_app') THEN
    CREATE ROLE cases_app LOGIN PASSWORD 'cases_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO cases_app;
-- No DELETE: the API never deletes cases. No grant on tenants: foreign key checks run as the table owner.
GRANT SELECT, INSERT, UPDATE ON cases TO cases_app;
