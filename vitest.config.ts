import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@chatagent/contracts': fileURLToPath(new URL('packages/contracts/src/index.ts', import.meta.url)),
      '@chatagent/hermes': fileURLToPath(new URL('packages/hermes/src/index.ts', import.meta.url)),
      '@chatagent/im-gateway': fileURLToPath(new URL('packages/im-gateway/src/index.ts', import.meta.url)),
      '@chatagent/document': fileURLToPath(new URL('packages/document/src/index.ts', import.meta.url)),
      '@chatagent/task-engine': fileURLToPath(new URL('packages/task-engine/src/index.ts', import.meta.url)),
      '@chatagent/agent-host': fileURLToPath(new URL('packages/agent-host/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/*/src/**/*.test.ts', 'apps/server/src/**/*.test.ts'],
  },
});
