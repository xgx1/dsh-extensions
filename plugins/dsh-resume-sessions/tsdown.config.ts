/**
 * tsdown config for dsh-resume-sessions: one host entry, no client half.
 * The built `lib/index.js` is what the web/headless profile loader imports.
 */
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'dsh-resume-sessions',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: true,
    clean: true,
  },
])
