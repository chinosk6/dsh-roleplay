/** User-facing settings (registered under the `roleplay` settings namespace). */
import z from '@deepseek-ai/schemastery'
import type { ImageSize } from './imagegen/types.ts'

export interface RoleplaySettings {
  /** Display name used for the player and substituted for the user macro. */
  userName: string
  /** Optional player persona injected below the character definition. */
  userPersona: string
  /** Selected image backend; `none` disables every image feature. */
  imageProvider: 'none' | 'novelai' | 'sdwebui' | 'url' | 'erpsex'
  novelaiApiUrl: string
  novelaiApiKey: string
  novelaiModel: string
  sdwebuiBaseUrl: string
  sdwebuiSteps: number
  sdwebuiCfgScale: number
  sdwebuiSampler: string
  urlTemplate: string
  /** Persistent API key (`pst-…`) of the ai.erp.sex gateway. */
  erpsexApiKey: string
  /** Model name; nai-* collapses to the gateway's `nai` type, others pass through. */
  erpsexModel: string
  /** Style prefix (artist/quality tags) prepended to every prompt. */
  stylePrompt: string
  negativePrompt: string
  imageSize: ImageSize
  /** Default images per reply when the model illustrates a scene. */
  imageCount: number
  /** Default auto-illustration state for new role-play sessions. */
  autoImage: boolean
  /** How strongly the model is pushed to illustrate each reply. */
  imageAggressiveness: 'conservative' | 'active' | 'force'
  /** Reference image for generation: none / the bound character's avatar / an uploaded image. */
  referenceMode: 'none' | 'avatar' | 'custom'
  /** How strongly the reference influences the output (0-1). */
  referenceStrength: number
  /** Choice mode: every reply ends with 2-8 clickable options. */
  choiceMode: boolean
  /** How many options the model offers per reply in choice mode. */
  choiceCount: number
}

export const RoleplaySettings: z<RoleplaySettings> = z.object({
  userName: z.string().default('你'),
  userPersona: z.string().default(''),
  imageProvider: z.union(['none', 'novelai', 'sdwebui', 'url', 'erpsex']).default('none'),
  novelaiApiUrl: z.string().default('https://image.novelai.net/ai/generate-image'),
  novelaiApiKey: z.string().default(''),
  novelaiModel: z.string().default('nai-diffusion-4-5-full'),
  sdwebuiBaseUrl: z.string().default('http://127.0.0.1:7860'),
  sdwebuiSteps: z.number().default(28),
  sdwebuiCfgScale: z.number().default(7),
  sdwebuiSampler: z.string().default('Euler a'),
  urlTemplate: z.string().default(''),
  erpsexApiKey: z.string().default(''),
  erpsexModel: z.string().default('nai-diffusion-4-5-full'),
  stylePrompt: z.string().default('very aesthetic, masterpiece, best quality'),
  negativePrompt: z.string().default(
    'lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry',
  ),
  imageSize: z.union(['portrait', 'landscape', 'square', 'ratio43', 'ratio169', 'ratio34', 'ratio916']).default('portrait'),
  imageCount: z.number().min(1).max(6).default(1),
  autoImage: z.boolean().default(false),
  imageAggressiveness: z.union(['conservative', 'active', 'force']).default('active'),
  referenceMode: z.union(['none', 'avatar', 'custom']).default('none'),
  referenceStrength: z.number().min(0).max(1).default(1),
  choiceMode: z.boolean().default(false),
  choiceCount: z.number().min(2).max(8).default(4),
})
