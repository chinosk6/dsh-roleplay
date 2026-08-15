/**
 * Generic URL-template backend: a GET endpoint that answers with image bytes.
 * The template may use `{prompt}`, `{negative}`, `{width}`, `{height}`
 * placeholders (URL-encoded on substitution), covering simple self-hosted or
 * wrapper services without a dedicated adapter.
 */
import type { ImageProvider, ImageRequest } from './types.ts'

export function createUrlTemplateProvider(template: () => string): ImageProvider {
  return {
    id: 'url',
    available: () => template().trim() !== '',
    async generate(request: ImageRequest): Promise<Buffer> {
      const referenceToken = request.reference
        ? encodeURIComponent(`data:image/png;base64,${request.reference.toString('base64')}`)
        : ''
      const url = template()
        .replaceAll('{prompt}', encodeURIComponent(request.prompt))
        .replaceAll('{negative}', encodeURIComponent(request.negativePrompt))
        .replaceAll('{width}', String(request.width))
        .replaceAll('{height}', String(request.height))
        .replaceAll('{reference}', referenceToken)
      const response = await fetch(url, { signal: request.signal ?? null })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`image API answered ${response.status}: ${detail}`)
      }
      const type = response.headers.get('content-type') ?? ''
      if (!type.startsWith('image/')) throw new Error(`image API answered content-type ${type || 'unknown'}`)
      return Buffer.from(await response.arrayBuffer())
    },
  }
}
