import pg from 'pg';

export const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/cases';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
