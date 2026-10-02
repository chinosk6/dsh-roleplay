/**
 * Host-plane plugin: provides the `roleplay` service (cards, bindings,
 * settings, image generation) and the `/x-roleplay` HTTP surface.
 *
 * The two session-mode agent presets are not written by this plugin: they
 * are `@deepseek-ai/dsh-agent-preset` rows declared next to this one in
 * cordis.patch.yml, and the preset registry mounts them.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-settings'
import { RoleplayService } from './service.ts'
import { registerRoutes } from './http.ts'
import { createSettingsStore, volatileSettingsFields, type LiveSettings } from './settings.ts'
import { GLOBAL_IMAGE_TOOL_NAME, registerImageTool } from './image-tool.ts'
import { gateRoleplayTools } from './tool-grants.ts'

export const name = 'roleplay'
export const inject = ['storageDomain', 'webServer', 'tools']

export interface Config extends LiveSettings {
  /** Directory holding avatars and generated images (default: <dshHome>/roleplay). */
  dataDir?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
  ...volatileSettingsFields,
}) as unknown as z<Config>

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = config.dataDir?.trim() ? config.dataDir : dshHomePath('roleplay')
  const settings = createSettingsStore(ctx, config)
  const service = new RoleplayService(ctx, dataDir, settings)
  await service.start()
  registerRoutes(ctx, service)
  gateRoleplayTools(ctx, settings)

  // This plugin ships its own settings page, so ask clients not to generate
  // one from the schema. Optional: the plugin runs without the settings
  // service (writes then fail with a clear message, see settings.ts).
  const owner = ctx.fiber
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, owner), 'settings.configure()')
  })

  // ── image tool outside role-play ──
  // Registered from this UNSCOPED host context, so it lands on the tools
  // service's GLOBAL layer and every session (standard/code/…) sees it. The
  // deliberately unusual name avoids same-layer collisions with other
  // plugins' `generate_image`; role-play / forge presets deny it (agent.ts).
  // The tool catalog is recomputed per request, so toggling takes effect for
  // existing sessions from their next message.
  let disposeGlobalImageTool: (() => void) | undefined
  const syncGlobalImageTool = () => {
    const enabled = settings.get().allowImageToolOutsideRoleplay
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
  ctx.effect(() => settings.watch(syncGlobalImageTool), 'roleplay.watch(global image tool)')

  ctx.logger.info('role-play plugin ready (data dir: %s)', dataDir)
}
