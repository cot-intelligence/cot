import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts so the dashboard build stays untouched by
// test tooling. Pure-logic unit tests live next to their source as *.test.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    environment: 'node',
  },
});
