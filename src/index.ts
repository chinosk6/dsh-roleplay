/**
 * Host-plane plugin: provides the `roleplay` service (cards, bindings,
 * settings, image generation), the `/x-roleplay` HTTP surface, and the two
 * session-mode agent presets.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RoleplayService } from './service.ts'
import { registerRoutes } from './http.ts'
import { materializePresets } from './presets.ts'

export const name = 'roleplay'
export const inject = ['settings', 'storageDomain', 'webServer']

export interface Config {
  /** Directory holding avatars and generated images (default: <dshHome>/roleplay). */
  dataDir?: string
}

export const Config: z<Config> = z.object({
  dataDir: z.string(),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const dataDir = config.dataDir?.trim() ? config.dataDir : dshHomePath('roleplay')
  const service = new RoleplayService(ctx, dataDir)
  await service.start()
  registerRoutes(ctx, service)
  try {
    await materializePresets()
  } catch (error) {
    ctx.logger.warn('failed to write agent presets: %s', error)
  }
  ctx.logger.info('role-play plugin ready (data dir: %s)', dataDir)
}
