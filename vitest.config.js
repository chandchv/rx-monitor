import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.{test,spec}.{js,mjs}'],
    environment: 'node',
    globals: false,
    testTimeout: 30000,
  },
});
