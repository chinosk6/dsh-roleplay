/**
 * Install-time build. npm-published tarballs already contain lib/, and
 * consumers do not get this package's devDependencies — skip in that case.
 * Git / path installs have no lib/ and must compile; that needs esbuild.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const built = ['index.js', 'agent.js', 'client.js'].every(name => existsSync(join(root, 'lib', name)))

let hasEsbuild = false
try {
  createRequire(import.meta.url).resolve('esbuild')
  hasEsbuild = true
} catch {
  // published install: esbuild is a devDependency and is not installed
}

if (!hasEsbuild) {
  if (built) {
    console.log('skip prepare: lib/ already present')
    process.exit(0)
  }
  console.error('esbuild is not installed and lib/ is missing. From a checkout run: pnpm install && pnpm run build')
  process.exit(1)
}

await import('./build.mjs')
