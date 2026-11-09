import pg from 'pg';

// API pool (cases_app, RLS applies)
export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://cases_app:cases_app@localhost:5432/cases';

// Admin pool (migrations, tests)
export const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cases';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
