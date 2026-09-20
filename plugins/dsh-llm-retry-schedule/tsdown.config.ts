/**
 * tsdown config for dsh-llm-retry-schedule: one host entry, no client half.
 * The built `lib/index.js` is what the web profile's loader imports.
 */
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'dsh-llm-retry-schedule',
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
