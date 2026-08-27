/**
 * Chat-upload access for the forge tools: enumerate the images the user
 * attached to their messages in this session and resolve one of them to PNG
 * bytes. The attachment service is read through `ctx.reflect.get` instead of
 * `inject` so the bundle still loads (and role-play mode keeps working) on a
 * host without the attachment feature.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { PNG } from 'pngjs'
import { decode as decodeJpeg } from 'jpeg-js'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** All image attachments in the session's user messages, in upload order. */
export function listUploadedImages(agent: Agent): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  try {
    for (const message of agent.session.deriveMessages()) {
      if (message.role !== 'user') continue
      if (!Array.isArray(message.content)) continue
      for (const block of message.content) {
        if (block && typeof block === 'object' && block.type === 'image') {
          refs.push((block as { attachment: ImageAttachmentRef }).attachment)
        }
      }
    }
  } catch {
    // an unreadable surface just means "no uploads"
  }
  return refs
}

/** Convert one accepted upload to PNG bytes; PNG passes through, JPEG is re-encoded. */
function toPngBytes(data: Uint8Array, mediaType: string): Buffer {
  if (mediaType === 'image/png') return Buffer.from(data)
  if (mediaType === 'image/jpeg') {
    const decoded = decodeJpeg(data, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
    const png = new PNG({ width: decoded.width, height: decoded.height })
    Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength).copy(png.data)
    return PNG.sync.write(png)
  }
  throw new Error(`暂不支持 ${mediaType} 格式的上传图片，请告知用户转成 PNG 或 JPEG 后重新上传`)
}

/** Reference files larger than this are refused before decoding. */
const MAX_LOCAL_IMAGE_BYTES = 32 * 1024 * 1024

/**
 * Resolve a local image file (PNG/JPEG, detected by magic bytes) to PNG bytes
 * for the generation-reference path of the global image tool. Requires an
 * absolute path: the host process cwd is unrelated to the conversation, so a
 * relative path would resolve somewhere the user never meant.
 */
export async function resolveLocalImagePng(path: string): Promise<Buffer> {
  const trimmed = path.trim()
  if (trimmed === '') throw new Error('参考图路径为空')
  if (!isAbsolute(trimmed)) throw new Error(`参考图路径必须是绝对路径（收到：${trimmed}）`)
  let data: Buffer
  try {
    data = await readFile(trimmed)
  } catch (error) {
    throw new Error(`读取参考图文件失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (data.byteLength > MAX_LOCAL_IMAGE_BYTES) {
    throw new Error(`参考图文件过大（${Math.round(data.byteLength / 1024 / 1024)}MB，上限 32MB）`)
  }
  // Detect by content, not extension: PNG \x89PNG…, JPEG \xFF\xD8\xFF.
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return toPngBytes(data, 'image/png')
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return toPngBytes(data, 'image/jpeg')
  }
  throw new Error('参考图文件不是 PNG 或 JPEG 图片（按文件内容判断）。请告知用户转成 PNG/JPEG 后重试')
}

/**
 * Resolve "the user's Nth uploaded image" to PNG bytes.
 * @param index - 1-based upload order; negative counts from the end (-1 = latest).
 */
export async function resolveUploadedImagePng(ctx: Context, agent: Agent | undefined, index: number): Promise<Buffer> {
  if (!agent) throw new Error('无法访问当前会话，读取不到上传的图片')
  const attachments = ctx.reflect.get('attachments') as AttachmentStore | undefined
  if (!attachments) throw new Error('当前宿主没有附件服务，无法读取聊天中上传的图片')
  const refs = listUploadedImages(agent)
  if (refs.length === 0) throw new Error('本会话中没有找到用户上传的图片')
  if (!Number.isInteger(index) || index === 0) {
    throw new Error(`图片序号必须是非零整数（1 为第一张，-1 为最新一张）；本会话共有 ${refs.length} 张上传图片`)
  }
  const position = index > 0 ? index - 1 : refs.length + index
  const ref = refs[position]
  if (!ref) throw new Error(`图片序号 ${index} 超出范围：本会话共有 ${refs.length} 张上传图片`)
  const stored = await attachments.readImage(ref)
  return toPngBytes(stored.data, ref.mediaType)
}
