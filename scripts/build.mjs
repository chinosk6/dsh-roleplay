/**
 * Build every published entry with esbuild:
 *  - lib/index.js, lib/agent.js — host-plane ESM bundles (dsh packages stay external)
 *  - lib/client.js — the browser bundle, wrapped in the module-loader factory
 *    the dsh web shell expects; `react` / `react/jsx-runtime` and dsh client
 *    packages resolve through the loader-provided `require`.
 */
import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

await build({
  entryPoints: [join(root, 'src/index.ts'), join(root, 'src/agent.ts')],
  outdir: join(root, 'lib'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2023',
  sourcemap: false,
  external: ['@deepseek-ai/*', 'zod', 'pngjs', 'node:*'],
  logLevel: 'warning',
})

const clientOut = await build({
  entryPoints: [join(root, 'client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  write: false,
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  logLevel: 'warning',
})

const body = clientOut.outputFiles[0].text
const wrapped = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${body}
\t\treturn module.exports;
\t}
});\n`
writeFileSync(join(root, 'lib/client.js'), wrapped)
console.log('built lib/index.js, lib/agent.js, lib/client.js')
