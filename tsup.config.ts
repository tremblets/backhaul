import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/app.ts'],
  format: ['esm'],
  outDir: 'build',
  bundle: true,
  splitting: false,
  clean: true,
  target: 'es2024',
});
