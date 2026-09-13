/**
 * Cross-version bridge for the HOST-plane dsh contract — the server-side peer
 * of `client/compat.ts`.
 *
 * Named ESM imports bind at load time, so a name the installed harness no
 * longer exports is a SyntaxError that takes the whole bundle down before
 * `apply()` ever runs. That is exactly how dsh 0.1.5 broke this plugin:
 *
 *   SyntaxError: The requested module '@deepseek-ai/dsh-settings'
 *   does not provide an export named 'settingsNamespace'
 *
 * Every symbol that has moved between harness versions is therefore read off
 * a NAMESPACE import, which binds whatever the module happens to export and
 * degrades to a runtime check instead of a dead plugin.
 *
 * What moved (0.1.0-rc.6 → 0.1.5):
 *  - `settingsNamespace()` is gone. `ctx.settings.register()` now takes the
 *    plain namespace string, validated at the type level. The old helper only
 *    checked the same `^[a-z][a-z0-9-]*$` pattern and returned its argument,
 *    so the raw string is the correct value on both versions.
 *  - the single `deployment:persona` slot became a prefix/suffix pair:
 *    `PERSONA_SECTION` → `PERSONA_PREFIX_SECTION`, and the `PERSONA_ORDER`
 *    constant → `ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`.
 *    The prefix is the slot the old single section occupied (order 0, the
 *    first section a model reads), so shadowing it reproduces the old
 *    behaviour; a deployment-configured persona SUFFIX, which older harnesses
 *    had no equivalent for, is left alone.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as settingsModule from '@deepseek-ai/dsh-settings'
import * as systemPromptModule from '@deepseek-ai/dsh-system-prompt'

/**
 * The namespace currency. 0.1.5 dropped the `settingsNamespace()` builder but
 * KEPT the branded type: `register()` now takes a plain validated string while
 * the `settings/*` events still carry `SettingsNamespace`. Branding here keeps
 * one helper usable at both kinds of call site.
 */
type SettingsNamespaceArg = SettingsNamespace

/** Optional members this plugin probes for, absent on one version or another. */
interface SettingsModuleShape {
  settingsNamespace?: (value: string) => SettingsNamespaceArg
}
interface SystemPromptModuleShape {
  /** 0.1.5+ — the deployment persona's leading slot. */
  PERSONA_PREFIX_SECTION?: string
  /** ≤0.1.2 — the single deployment persona slot. */
  PERSONA_SECTION?: string
  /** ≤0.1.2 — that slot's fixed order; centrally owned since 0.1.5. */
  PERSONA_ORDER?: number
}

const settingsFace = settingsModule as SettingsModuleShape
const systemPromptFace = systemPromptModule as SystemPromptModuleShape

/**
 * A settings namespace in the form this harness's `register` wants.
 * @param name - lowercase kebab-case namespace, as in plugin short names.
 */
export function settingsNs(name: string): SettingsNamespaceArg {
  const brand = settingsFace.settingsNamespace
  return brand === undefined ? (name as SettingsNamespaceArg) : brand(name)
}

/**
 * The prompt section a preset persona shadows. Naming the SAME section as the
 * deployment persona is what makes the contribution replace it rather than
 * sit beside it, so this value has to track the harness's own constant.
 */
export const PERSONA_SECTION_NAME: string =
  systemPromptFace.PERSONA_PREFIX_SECTION
  ?? systemPromptFace.PERSONA_SECTION
  // Neither export present: assume a harness newer than the split.
  ?? 'deployment:persona-prefix'

/**
 * That section's sort order.
 * @param ctx - any context carrying the systemPrompt service.
 * @returns the harness-owned order, or the historical constant 0.
 */
export function personaSectionOrder(ctx: Context): number {
  const service = ctx.systemPrompt as { getSectionOrder?: (name: string) => number }
  if (typeof service.getSectionOrder === 'function') {
    return service.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')
  }
  return systemPromptFace.PERSONA_ORDER ?? 0
}
