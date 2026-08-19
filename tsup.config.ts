import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli/index.ts'],
  format: ['esm'],
  outDir: 'build',
  bundle: true,
  splitting: false,
  clean: true,
  target: 'es2024',
  esbuildOptions(options) {
    Object.assign(options, {
      alias: {
        ...options.alias,
        '@': resolve(__dirname, 'src'),
      },
    });
  },
});
