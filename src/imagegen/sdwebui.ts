/** Stable Diffusion WebUI backend (`/sdapi/v1/txt2img`) — the fully local option. */
import type { ImageProvider, ImageRequest } from './types.ts'

export interface SdWebUiConfig {
  baseUrl: string
  steps: number
  cfgScale: number
  sampler: string
}

export function createSdWebUiProvider(config: () => SdWebUiConfig): ImageProvider {
  return {
    id: 'sdwebui',
    available: () => config().baseUrl.trim() !== '',
    async generate(request: ImageRequest): Promise<Buffer> {
      const { baseUrl, steps, cfgScale, sampler } = config()
      const endpoint = request.reference ? 'img2img' : 'txt2img'
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/sdapi/v1/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: request.prompt,
          negative_prompt: request.negativePrompt,
          width: request.width,
          height: request.height,
          steps,
          cfg_scale: cfgScale,
          sampler_name: sampler,
          batch_size: 1,
          ...(request.reference
            ? {
                init_images: [request.reference.toString('base64')],
                denoising_strength: Math.min(1, Math.max(0.05, 1 - (request.referenceStrength ?? 1))),
              }
            : {}),
        }),
        signal: request.signal ?? null,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`image API answered ${response.status}: ${detail}`)
      }
      const payload = (await response.json()) as { images?: string[] }
      const first = payload.images?.[0]
      if (!first) throw new Error('image API returned no images')
      return Buffer.from(first, 'base64')
    },
  }
}
