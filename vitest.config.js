import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Key derivation (PBKDF2, 600k iterations) and multi-process tests are slow on shared CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.js'],
  },
});
