/**
 * NovelAI image backend. The API answers with a ZIP archive; the first PNG
 * entry is the image. The archive is parsed directly (end-of-central-directory
 * → central directory → local header) with `zlib.inflateRawSync` for deflated
 * entries, so no archive dependency is needed.
 */
import { inflateRawSync } from 'node:zlib'
import { randomBytes, randomInt } from 'node:crypto'
import type { ImageProvider, ImageRequest } from './types.ts'
import { coverToCanvas, normalizeDirectorReference } from './normalize.ts'

export interface NovelAiConfig {
  apiUrl: string
  apiKey: string
  model: string
}

export interface NovelAiPoints {
  /** Total spendable balance: fixed (subscription) + purchased steps. */
  points: number
  fixedTrainingStepsLeft: number
  purchasedTrainingSteps: number
}

/**
 * Query the account's Anlas balance from the fixed subscription endpoint
 * (independent of the configured generation apiUrl). The spendable total is
 * trainingStepsLeft.fixedTrainingStepsLeft + purchasedTrainingSteps.
 * Auth failures answer 401 with { statusCode, message }.
 */
export async function fetchNovelAiPoints(apiKey: string, signal?: AbortSignal): Promise<NovelAiPoints> {
  const response = await fetch('https://image.novelai.net/user/subscription', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ?? null,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { message?: string }
      if (typeof parsed.message === 'string') detail = parsed.message
    } catch {
      // keep raw text
    }
    throw new Error(`点数查询失败（HTTP ${response.status}）：${detail}`)
  }
  const body = (await response.json()) as {
    trainingStepsLeft?: { fixedTrainingStepsLeft?: number; purchasedTrainingSteps?: number }
  }
  const fixed = typeof body.trainingStepsLeft?.fixedTrainingStepsLeft === 'number' ? body.trainingStepsLeft.fixedTrainingStepsLeft : 0
  const purchased = typeof body.trainingStepsLeft?.purchasedTrainingSteps === 'number' ? body.trainingStepsLeft.purchasedTrainingSteps : 0
  return { points: fixed + purchased, fixedTrainingStepsLeft: fixed, purchasedTrainingSteps: purchased }
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

/** NAI v5 family (`nai-diffusion-5-*`): multipart wire format, no director references yet. */
export function isNaiV5Model(model: string): boolean {
  return /^nai-diffusion-5(-|$)/i.test(model.trim())
}

/** Fields shared by the v4/v4.5 and v5 parameter blocks. */
function captionBlocks(request: ImageRequest) {
  return {
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
  }
}

/** v4/v4.5 body: JSON, the reference rides as a director (character & style) reference. */
function v4Body(model: string, request: ImageRequest, seed: number) {
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
  return {
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
      ...captionBlocks(request),
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
}

/**
 * v5 body. v5 has no director references yet, so a reference image turns the
 * call into img2img; the source image itself travels as the separate `image`
 * form part, not inside this JSON. Strength and noise are NovelAI's own
 * img2img knobs (its UI defaults: 0.7 / 0).
 */
function v5Body(model: string, request: ImageRequest, seed: number, img2img: boolean) {
  const medium = /-medium$/i.test(model.trim())
  return {
    input: request.prompt,
    model,
    action: img2img ? 'img2img' : 'generate',
    use_new_shared_trial: true,
    parameters: {
      params_version: 4,
      width: request.width,
      height: request.height,
      scale: 5,
      sampler: 'k_euler_ancestral',
      steps: medium ? 14 : 28,
      seed,
      n_samples: 1,
      ucPresetId: 'heavy',
      qualityPresetId: 'none',
      autoSmea: false,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: true,
      ...(medium ? {} : { cfg_rescale: 0 }),
      legacy_v3_extend: false,
      use_coords: false,
      normalize_reference_strength_multiple: true,
      inpaintImg2ImgStrength: 1,
      legacy_uc: false,
      characterPrompts: [],
      straight_alpha: true,
      tag_hint_qt: 0,
      tag_hint_uc_preset: 2,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      noise_schedule: 'karras',
      image_format: 'png',
      ...captionBlocks(request),
      ...(img2img
        ? {
            strength: Math.min(0.99, Math.max(0.01, request.img2imgStrength ?? 0.7)),
            noise: Math.min(0.99, Math.max(0, request.img2imgNoise ?? 0)),
            extra_noise_seed: seed,
          }
        : {}),
    },
  }
}

export function createNovelAiProvider(config: () => NovelAiConfig): ImageProvider {
  return {
    id: 'novelai',
    available: () => config().apiKey.trim() !== '',
    async generate(request: ImageRequest): Promise<Buffer> {
      const { apiUrl, apiKey, model: rawModel } = config()
      const model = rawModel.trim()
      const seed = randomInt(1, 4_294_967_295)
      let init: RequestInit
      if (isNaiV5Model(model)) {
        // img2img sources must match the output size; a reference that fails
        // to decode falls back to plain text-to-image.
        let source: Buffer | undefined
        if (request.reference) {
          try {
            source = coverToCanvas(request.reference, request.width, request.height)
          } catch {
            source = undefined
          }
        }
        const form = new FormData()
        form.append(
          'request',
          new Blob([JSON.stringify(v5Body(model, request, seed, source !== undefined))], { type: 'application/json' }),
          'blob',
        )
        if (source) form.append('image', new Blob([new Uint8Array(source)], { type: 'image/png' }), 'image.png')
        // fetch sets the multipart Content-Type (with boundary) itself.
        init = { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form }
      } else {
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(v4Body(model, request, seed)),
        }
      }
      const response = await fetch(apiUrl, { ...init, signal: request.signal ?? null })
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300)
        throw new Error(`image API answered ${response.status}: ${detail}`)
      }
      return firstZipEntry(Buffer.from(await response.arrayBuffer()))
    },
  }
}
