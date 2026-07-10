import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    timeout: 30_000,
    pool: 'forks',
    server: {
      deps: {
        // Let Node resolve these natively as ESM rather than bundling via esbuild
        // This ensures ws's wrapper.mjs (with named WebSocketServer export) is used
        external: ['ws', '@noble/ed25519'],
      },
    },
  },
});
