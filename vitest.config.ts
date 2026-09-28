import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite печатает ExperimentalWarning — не шумим
    env: { NODE_NO_WARNINGS: '1' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/node/**'],
      reporter: ['text-summary', 'text'],
      thresholds: {
        'src/core/**': { statements: 85, branches: 80, functions: 85, lines: 85 },
      },
    },
  },
});
