import { defineConfig } from 'vitest/config';

// Optional .env
try {
  process.loadEnvFile('.env');
} catch {}

// One database, files run in sequence
export default defineConfig({ test: { fileParallelism: false } });
