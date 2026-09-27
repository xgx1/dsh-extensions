/**
 * tsdown config for dsh-laya-router: one host entry, no client half.
 * The built `lib/index.js` is what the profile's loader imports.
 */
import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    name: 'dsh-laya-router',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: true,
    // Harness packages resolve from the installation at runtime. They sit in
    // devDependencies for types only, so they must never be inlined here —
    // bundling one would give the process a second copy of its own services.
    deps: { neverBundle: [/^@deepseek-ai\//] },
  },
])
