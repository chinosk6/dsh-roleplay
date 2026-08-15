/** Image generation provider seam. */

/**
 * Supported output shapes (keyword form kept stable in settings/bindings).
 * `ratio43`/`ratio34` are legacy aliases of landscape/portrait kept so stored
 * settings keep validating; the UI only ever offers the other five.
 */
export const IMAGE_SIZES = ['portrait', 'landscape', 'square', 'ratio43', 'ratio169', 'ratio34', 'ratio916'] as const
export type ImageSize = (typeof IMAGE_SIZES)[number]

export interface ImageRequest {
  /** Final positive prompt (style prefix already applied). */
  prompt: string
  negativePrompt: string
  width: number
  height: number
  /** Aspect keyword (`3:4` style) for backends that take a ratio, not pixels. */
  aspect?: string | undefined
  signal?: AbortSignal | undefined
  /** Optional reference image (PNG bytes) for img2img / vibe transfer. */
  reference?: Buffer | undefined
  /** How strongly the reference influences the output (0-1). */
  referenceStrength?: number | undefined
}

export interface ImageProvider {
  readonly id: string
  /** Cheap local readiness check (config/credential presence, no network). */
  available(): boolean
  /** Produce one PNG image. */
  generate(request: ImageRequest): Promise<Buffer>
}

/** Map a size keyword to pixel dimensions (64-multiples within the 1MP budget). */
export function dimensionsOf(size: ImageSize): { width: number; height: number } {
  switch (size) {
    case 'portrait':
    case 'ratio34': return { width: 896, height: 1152 }
    case 'landscape':
    case 'ratio43': return { width: 1152, height: 896 }
    case 'square': return { width: 1024, height: 1024 }
    case 'ratio169': return { width: 1344, height: 768 }
    case 'ratio916': return { width: 768, height: 1344 }
  }
}

/** Map a size keyword to the `w:h` ratio string ratio-based backends accept. */
export function aspectOf(size: ImageSize): string {
  switch (size) {
    case 'portrait':
    case 'ratio34': return '3:4'
    case 'landscape':
    case 'ratio43': return '4:3'
    case 'square': return '1:1'
    case 'ratio169': return '16:9'
    case 'ratio916': return '9:16'
  }
}
