import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
        'node_modules/**',
        'gemini-cli/**',
        'acp-spec/**',
        'zed/**'
    ],
    setupFiles: ['./src/test-setup.ts'],
    },
});
