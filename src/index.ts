/**
 * Host-plane plugin: provides the `roleplay` service (cards, bindings,
 * settings, image generation), the `/x-roleplay` HTTP surface, and the two
 * session-mode agent presets.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { RoleplayService } from './service.ts'
import { registerRoutes } from './http.ts'
import { materializePresets, type PresetLocale } from './presets.ts'
import { GLOBAL_IMAGE_TOOL_NAME, registerImageTool } from './image-tool.ts'

export const name = 'roleplay'
export const inject = ['settings', 'storageDomain', 'webServer', 'tools']

export interface Config {
  /** Directory holding avatars and generated images (default: <dshHome>/roleplay). */
  dataDir?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
})

/** The locale namespace is owned by the dsh locale plugin; read-only here. */
const LOCALE_NS = settingsNamespace('locale')

/** The roleplay settings namespace, registered by RoleplayService. */
const ROLEPLAY_NS = settingsNamespace('roleplay')

/** Namespace the preset-picker UIs key their roster-refresh event on. */
const AGENT_PRESETS_NS = settingsNamespace('agent-presets')

/** Resolve the preset display language from the host locale section. */
function presetLocaleOf(section: unknown): PresetLocale {
  const preference = typeof section === 'object' && section !== null
    ? (section as { preference?: unknown }).preference
    : undefined
  return preference === 'en' ? 'en' : 'zh'
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = config.dataDir?.trim() ? config.dataDir : dshHomePath('roleplay')
  const service = new RoleplayService(ctx, dataDir)
  await service.start()
  registerRoutes(ctx, service)
  // Connected pickers cache the preset roster; they re-read it when the host
  // announces a document update for the `agent-presets` namespace (the event
  // is on the api-remotes forward whitelist). Re-emitting the live revision
  // keeps configuration surfaces' staleness accounting intact.
  const notifyRosterChanged = () => {
    const revision = ctx.settings.describe({ redactSecrets: true })
      .find(descriptor => descriptor.ns === AGENT_PRESETS_NS)?.revision ?? 0
    ctx.emit('settings/document-updated', AGENT_PRESETS_NS, revision)
  }
  const writePresets = async () => {
    try {
      const { allowFileTools, allowWebTools } = service.settings.get()
      const changed = await materializePresets(
        presetLocaleOf(ctx.settings.get(LOCALE_NS)),
        { allowFileTools, allowWebTools },
      )
      if (changed) notifyRosterChanged()
    } catch (error) {
      ctx.logger.warn('failed to write agent presets: %s', error)
    }
  }
  await writePresets()

  // ── image tool outside role-play ──
  // Registered from this UNSCOPED host context, so it lands on the tools
  // service's GLOBAL layer and every session (standard/code/…) sees it. The
  // deliberately unusual name avoids same-layer collisions with other
  // plugins' `generate_image`; role-play / forge presets deny it (agent.ts).
  // The tool catalog is recomputed per request, so toggling takes effect for
  // existing sessions from their next message.
  let disposeGlobalImageTool: (() => void) | undefined
  const syncGlobalImageTool = () => {
    const enabled = service.settings.get().allowImageToolOutsideRoleplay
    if (enabled && !disposeGlobalImageTool) {
      if (ctx.tools.get(GLOBAL_IMAGE_TOOL_NAME) !== undefined) {
        ctx.logger.warn('global tool "%s" already exists (another plugin?); leaving the outside-role-play image tool unregistered', GLOBAL_IMAGE_TOOL_NAME)
        return
      }
      try {
        disposeGlobalImageTool = registerImageTool(ctx, {
          name: GLOBAL_IMAGE_TOOL_NAME,
          background: true,
          uploadReference: true,
          fileReference: true,
          flavor: 'generic',
        })
      } catch (error) {
        ctx.logger.warn('failed to register the outside-role-play image tool: %s', error)
      }
    } else if (!enabled && disposeGlobalImageTool) {
      disposeGlobalImageTool()
      disposeGlobalImageTool = undefined
    }
  }
  syncGlobalImageTool()

  // Keep the preset display text in the UI language, and re-materialize the
  // role-play composition whenever a risk toggle changes.
  ctx.on('settings/updated', ns => {
    if (ns === LOCALE_NS || ns === ROLEPLAY_NS) void writePresets()
    if (ns === ROLEPLAY_NS) syncGlobalImageTool()
  })
  // The locale namespace may register after this plugin loads, in which case
  // the first write above fell back to Chinese. Poll briefly for the
  // registration and write once more; identical content is skipped anyway.
  if (ctx.settings.get(LOCALE_NS) === undefined) {
    void (async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise(resolvePoll => setTimeout(resolvePoll, 1000))
        if (ctx.settings.get(LOCALE_NS) !== undefined) {
          await writePresets()
          return
        }
      }
    })()
  }
  ctx.logger.info('role-play plugin ready (data dir: %s)', dataDir)
}
