import pg from 'pg';

// The API connects as cases_app, a role that row-level security applies to (migrations/002_app_role.sql).
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cases_app:cases_app@localhost:5432/cases';

// Migrations and test setup need a role that can create tables and roles. The API never uses it.
export const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cases';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
