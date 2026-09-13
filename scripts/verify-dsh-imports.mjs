/**
 * Check the BUILT bundles against the harness the user actually runs.
 *
 * Why this exists: the plugin's devDependencies put copies of the dsh
 * packages inside this checkout's own `node_modules`, and the profile links
 * the plugin from here — so Node resolves `@deepseek-ai/*` to those dev
 * copies, not to the ones inside the installed dsh. A symbol the shipped
 * harness has dropped therefore keeps resolving locally and only explodes on
 * a user's machine, where the plugin's own install carries the current
 * version. dsh 0.1.5 removing `settingsNamespace` shipped exactly that way:
 * "The requested module '@deepseek-ai/dsh-settings' does not provide an
 * export named 'settingsNamespace'".
 *
 * A named ESM import binds at load time, so a miss is not a degraded feature
 * — it is a SyntaxError that takes the whole plugin down before apply() runs.
 * Hence the rule this script enforces: every named import of a dsh package in
 * lib/*.js must exist in the INSTALLED dsh. Anything that legitimately varies
 * across versions belongs behind a namespace import (src/dsh-compat.ts,
 * client/compat.ts), which this check ignores because it cannot fail to bind.
 *
 * Skips (exit 0) when no dsh installation is found, so CI without one passes.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'

/**
 * Root holding the harness's own `@deepseek-ai/*` copies, found by walking
 * PATH for the dsh launcher rather than shelling out to `npm root -g` (Node
 * refuses to spawn a .cmd without a shell, and a shell here is both slower
 * and an injection surface). Both global layouts are probed: npm on Windows
 * keeps packages beside the launcher, elsewhere under `<prefix>/lib`.
 */
function dshPackagesRoot() {
  const override = process.env.DSH_PACKAGE_ROOT
  if (override !== undefined && existsSync(override)) return override
  const tail = join('@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    const bin = entry.trim()
    if (bin === '') continue
    for (const candidate of [
      join(bin, 'node_modules', tail),
      join(dirname(bin), 'lib', 'node_modules', tail),
    ]) {
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/** Names a built package's entry re-exports. */
function exportedNames(root, pkg) {
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    const file = join(root, pkg, entry)
    if (!existsSync(file)) continue
    const line = readFileSync(file, 'utf8').split('\n').reverse().find(row => row.startsWith('export {'))
    if (line === undefined) continue
    return new Set(line
      .replace(/^export \{/, '')
      .replace(/\};?\s*$/, '')
      .split(',')
      .map(name => name.trim().split(/\s+as\s+/).pop().trim())
      .filter(Boolean))
  }
  return undefined
}

const root = dshPackagesRoot()
if (root === undefined) {
  console.log('verify-dsh-imports: no dsh installation found — skipped')
  process.exit(0)
}

const failures = []
let checked = 0
for (const file of readdirSync('lib').filter(name => name.endsWith('.js'))) {
  const source = readFileSync(join('lib', file), 'utf8')
  const imports = /import\s*\{([^}]*)\}\s*from\s*"(@deepseek-ai\/[^"]+)"/g
  let match
  while ((match = imports.exec(source)) !== null) {
    const pkg = match[2].slice('@deepseek-ai/'.length).split('/')[0]
    const names = match[1]
      .split(',')
      .map(name => name.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    const exported = exportedNames(root, pkg)
    if (exported === undefined) {
      // Browser-plane packages resolve through the web module table, not Node.
      continue
    }
    for (const name of names) {
      checked += 1
      if (!exported.has(name)) failures.push(`lib/${file}: @deepseek-ai/${pkg} has no export "${name}"`)
    }
  }
}

if (failures.length > 0) {
  console.error(`verify-dsh-imports: ${failures.length} import(s) the installed dsh does not provide:`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nMove the symbol behind a namespace import in src/dsh-compat.ts so both versions load.')
  process.exit(1)
}
console.log(`verify-dsh-imports: ${checked} named import(s) resolve against the installed dsh`)
