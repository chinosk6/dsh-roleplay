/**
 * NovelAI image backend. The API answers with a ZIP archive; the first PNG
 * entry is the image. The archive is parsed directly (end-of-central-directory
 * → central directory → local header) with `zlib.inflateRawSync` for deflated
 * entries, so no archive dependency is needed.
 */
import { inflateRawSync } from 'node:zlib'
import { randomBytes, randomInt } from 'node:crypto'
import type { ImageProvider, ImageRequest } from './types.ts'
import { normalizeDirectorReference } from './normalize.ts'

export interface NovelAiConfig {
  apiUrl: string
  apiKey: string
  model: string
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50

function firstZipEntry(zip: Buffer): Buffer {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('image response is not a ZIP archive')
  let offset = zip.readUInt32LE(eocd + 16)
  while (offset + 46 <= zip.length && zip.readUInt32LE(offset) === CENTRAL) {
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const localOffset = zip.readUInt32LE(offset + 42)
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = zip.subarray(dataStart, dataStart + compressedSize)
    if (method === 0) return Buffer.from(data)
    if (method === 8) return inflateRawSync(data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error('ZIP archive holds no readable entry')
}

export function createNovelAiProvider(config: () => NovelAiConfig): ImageProvider {
  return {
    id: 'novelai',
    available: () => config().apiKey.trim() !== '',
    async generate(request: ImageRequest): Promise<Buffer> {
      const { apiUrl, apiKey, model } = config()
      const seed = randomInt(1, 10_000_000_000)
      // The v4 director-reference path requires the image normalized onto one
      // of the accepted canvases; a raw image answers 400. A failed
      // normalization drops the reference rather than failing the generation.
      let reference: string | undefined
      if (request.reference) {
        try {
          reference = normalizeDirectorReference(request.reference).toString('base64')
        } catch {
          reference = undefined
        }
      }
      const body = {
        input: request.prompt,
        model,
        action: 'generate',
        use_new_shared_trial: true,
        parameters: {
          params_version: 3,
          width: request.width,
          height: request.height,
          scale: 5,
          sampler: 'k_euler_ancestral',
          steps: 28,
          seed,
          n_samples: 1,
          ucPreset: 0,
          qualityToggle: true,
          autoSmea: false,
          dynamic_thresholding: false,
          controlnet_strength: 1,
          legacy: false,
          add_original_image: true,
          cfg_rescale: 0,
          noise_schedule: 'karras',
          legacy_v3_extend: false,
          skip_cfg_above_sigma: null,
          use_coords: false,
          legacy_uc: false,
          normalize_reference_strength_multiple: true,
          inpaintImg2ImgStrength: 1,
          characterPrompts: [],
          deliberate_euler_ancestral_bug: false,
          prefer_brownian: true,
          image_format: 'png',
          v4_prompt: {
            caption: { base_caption: request.prompt, char_captions: [] },
            use_coords: false,
            use_order: true,
          },
          v4_negative_prompt: {
            caption: { base_caption: request.negativePrompt, char_captions: [] },
            legacy_uc: false,
          },
          negative_prompt: request.negativePrompt,
          ...(reference
            ? {
                director_reference_descriptions: [{
                  caption: { base_caption: 'character&style', char_captions: [] },
                  legacy_uc: false,
                }],
                director_reference_information_extracted: [1],
                director_reference_strength_values: [1],
                director_reference_secondary_strength_values: [0],
                director_reference_images_cached: [{
                  cache_secret_key: randomBytes(32).toString('hex'),
                  data: reference,
                }],
              }
            : {}),
        },
      }
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal ?? null,
      })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`image API answered ${response.status}: ${detail}`)
      }
      return firstZipEntry(Buffer.from(await response.arrayBuffer()))
    },
  }
}
