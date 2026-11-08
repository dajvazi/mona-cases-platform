import { defineConfig } from 'vitest/config';

// Same optional .env as `npm run dev` and `npm run migrate`; CI sets the variables directly.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment and the defaults in src/db.ts
}

// The tests share one database, so test files run one after another.
export default defineConfig({ test: { fileParallelism: false } });
