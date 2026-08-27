/**
 * The image-generation tool, shared by both planes: the session-plane presets
 * register it as `generate_image` in their own scope (role-play / forge
 * flavors), and the host plane registers a globally visible variant under
 * {@link GLOBAL_IMAGE_TOOL_NAME} when the "outside role-play" toggle is on.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveLocalImagePng, resolveUploadedImagePng } from './uploads.ts'
import { imageTagGuide } from './prompts.ts'
import type {} from './service.ts'

/**
 * Model-facing name of the host-plane global registration. `generate_image`
 * is far too generic for the global layer — another plugin registering the
 * same name in the same layer would throw — so the global variant exports a
 * deliberately unusual name instead. The role-play / forge presets keep their
 * scoped `generate_image` and additionally deny this name (see agent.ts), so
 * their sessions never see two image tools.
 */
export const GLOBAL_IMAGE_TOOL_NAME = 'generate_image_danbooru_rp'

export interface ImageToolOptions {
  /** Tool name to register (default `generate_image`). */
  name?: string
  /**
   * true = the tool returns as soon as the tasks are queued so the reply keeps
   * streaming while images render (the client polls readiness). Forge mode
   * keeps `false`: an avatar id must exist on disk before save_character_card
   * copies it.
   */
  background: boolean
  /** Expose the `reference_upload_index` parameter (chat-uploaded reference image). */
  uploadReference?: boolean
  /** Expose the `reference_avatar_card_id` parameter (forge mode only). */
  avatarReference?: boolean
  /**
   * Expose the `reference_image_path` parameter (local PNG/JPEG file as the
   * generation reference). Global variant only: it lets sessions whose model
   * cannot take image input still reference a picture by naming its path.
   */
  fileReference?: boolean
  /** Wording: role-play story flavor, or generic wording for ordinary sessions. */
  flavor?: 'roleplay' | 'generic'
}

/** Register the tool on the calling context's layer; returns the exact disposer. */
export function registerImageTool(ctx: Context, options: ImageToolOptions): () => void {
  const { name = 'generate_image', background, uploadReference = false, avatarReference = false, fileReference = false, flavor = 'roleplay' } = options

  const referenceHints: string[] = []
  if (uploadReference) referenceHints.push('若用户上传了图片并希望以其为参考（画风、人物特征等），传 reference_upload_index 指定用哪一张')
  if (avatarReference) referenceHints.push('若用户希望以某张角色卡当前的头像为参考（如"以现在的头像为参考换头像"），传 reference_avatar_card_id')
  if (fileReference) referenceHints.push('若用户指定了本机图片文件作为参考（给出了文件路径），传 reference_image_path')
  const referenceSuffix = referenceHints.length > 0 ? `${referenceHints.join('；')}。用户没有参考意图时都不要传。` : ''

  return ctx.tools.register(defineTool({
    name,
    // Role-play / forge sessions get the tag guide from their per-turn prompt
    // sections (prompts.ts); the generic variant has no session-plane prompt
    // hook, so it carries the full guide in the description instead.
    description: (flavor === 'generic'
      ? '生成图片并直接展示给用户。注意：prompt 只支持英文 danbooru（NovelAI）风格 tag，逗号分隔，不支持自然语言句子——写句子会显著劣化出图效果。'
        + referenceSuffix
        + `\n\n${imageTagGuide(name)}`
      : '为当前场景生成插图。prompt 使用英文 danbooru 风格 tag（逗号分隔）：主体身份、外貌、表情姿势、动作、服装、环境光照、构图镜头。成人画面带 nsfw；用户在场用 pov、不要画用户的脸。生成的图片会直接展示给用户。'
        + referenceSuffix),
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: flavor === 'generic'
          ? 'English danbooru/NovelAI-style tags, comma separated. Tags ONLY — natural-language sentences are not supported'
          : 'English danbooru-style tags, comma separated',
      },
      count: {
        type: 'number',
        description: flavor === 'generic'
          ? 'Number of images (1-6); omit to use the configured default'
          : 'Number of images (1-6); omit to use the configured default. Pass 1 when interleaving several illustrations between paragraphs',
      },
      ...(uploadReference
        ? {
            reference_upload_index: {
              type: 'number' as const,
              description: '以用户在本会话上传的第 N 张图片为生成参考图：按上传顺序 1 为第一张，-1 为最新一张。仅支持 PNG/JPEG 上传图',
            },
          }
        : {}),
      ...(avatarReference
        ? {
            reference_avatar_card_id: {
              type: 'string' as const,
              description: '以该 card_id 对应角色卡的当前头像为生成参考图。与 reference_upload_index 二选一（同时传以上传图为准）',
            },
          }
        : {}),
      ...(fileReference
        ? {
            reference_image_path: {
              type: 'string' as const,
              description: '以本机图片文件为生成参考图：传该文件的绝对路径，仅支持 PNG/JPEG。与 reference_upload_index 同时传时以上传图为准',
            },
          }
        : {}),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                url: { type: 'string', required: true },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: background
          ? (flavor === 'generic'
              ? `已安排 ${value.images.length} 张图片在后台生成，完成后会自动展示给用户。不要等待生成、不要提及生成过程、不要在回复中粘贴图片链接。`
              : `已安排 ${value.images.length} 张插图在后台生成，完成后会自动展示给用户。请立即继续正文剧情：不要等待生成、不要提及生成过程、不要在回复中粘贴图片链接。`)
          : (flavor === 'generic'
              ? `已生成 ${value.images.length} 张图片并直接展示给用户。不要在回复中粘贴图片链接。`
              : [
                  `已生成 ${value.images.length} 张图片并直接展示给用户：`,
                  ...value.images.map((image, index) => `第 ${index + 1} 张 image_id: ${image.id}`),
                  '需要设为头像时，把对应 image_id 作为 avatar_image_id 传给 save_character_card。不要在回复中粘贴图片链接。',
                ].join('\n')),
      }],
      presentationMeta: (_args, value) => ({ images: value.images }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const binding = agentId ? ctx.roleplay.getBinding(agentId) : undefined
      const count = args.count ?? binding?.imageCount ?? ctx.roleplay.settings.get().imageCount
      const extra = args as { reference_upload_index?: number; reference_avatar_card_id?: string; reference_image_path?: string }
      let reference: Buffer | undefined
      if (uploadReference && extra.reference_upload_index !== undefined) {
        reference = await resolveUploadedImagePng(ctx, exec.agent, extra.reference_upload_index)
      } else if (avatarReference && extra.reference_avatar_card_id) {
        reference = await ctx.roleplay.cardAvatarPng(extra.reference_avatar_card_id, binding?.workspacePath)
      } else if (fileReference && extra.reference_image_path) {
        reference = await resolveLocalImagePng(extra.reference_image_path)
      }
      const images = await ctx.roleplay.generateImages(
        args.prompt,
        count,
        background ? undefined : exec.signal,
        agentId,
        !background,
        reference,
      )
      return { images }
    },
  }))
}
