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
 * The settings seam is no longer bridged here: dsh 0.2 replaced the
 * namespace registry with volatile row Config (src/settings.ts), a model with
 * no older equivalent, and this plugin now requires 0.2.
 *
 * What moved (0.1.0-rc.6 → 0.1.5):
 *  - the single `deployment:persona` slot became a prefix/suffix pair:
 *    `PERSONA_SECTION` → `PERSONA_PREFIX_SECTION`, and the `PERSONA_ORDER`
 *    constant → `ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`.
 *    The prefix is the slot the old single section occupied (order 0, the
 *    first section a model reads), so shadowing it reproduces the old
 *    behaviour; a deployment-configured persona SUFFIX, which older harnesses
 *    had no equivalent for, is left alone.
 */
import type { Context } from '@deepseek-ai/cordis'
import * as systemPromptModule from '@deepseek-ai/dsh-system-prompt'

interface SystemPromptModuleShape {
  /** 0.1.5+ — the deployment persona's leading slot. */
  PERSONA_PREFIX_SECTION?: string
  /** ≤0.1.2 — the single deployment persona slot. */
  PERSONA_SECTION?: string
  /** ≤0.1.2 — that slot's fixed order; centrally owned since 0.1.5. */
  PERSONA_ORDER?: number
}

const systemPromptFace = systemPromptModule as SystemPromptModuleShape

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
