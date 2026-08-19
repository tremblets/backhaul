import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    globals: true,
    include: ['__tests__/**/*.test.ts'],
    alias: {
      '@': './src',
    },
    setupFiles: ['./__tests__/setup.ts'],
    coverage: {
      provider: 'v8',
      reportOnFailure: true,
    },
  },
});
