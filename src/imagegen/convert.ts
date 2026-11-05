/**
 * Image-format normalization: everything this plugin stores (avatars,
 * reference images, generated images) is PNG on disk, but inputs arrive as
 * whatever the user picked, the chat attachment held, or the backend
 * answered. The format is detected from the content (magic bytes), never from
 * a file name or declared media type.
 *
 * Decoders are pure JS / wasm (no native build): PNG via pngjs, JPEG via
 * jpeg-js, WebP via libwebp compiled to wasm (@cwasm/webp), GIF via omggif
 * (first frame). The wasm and GIF decoders load lazily on first use.
 */
import { createRequire } from 'node:module'
import { PNG } from 'pngjs'
import { decode as decodeJpeg } from 'jpeg-js'

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif'

/** Formats {@link toPng} can decode, for user-facing messages. */
export const SUPPORTED_IMAGE_FORMATS = 'PNG / JPEG / WebP / GIF'

/** Detect the image format from its leading bytes. */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat | undefined {
  const at = (offset: number, ascii: string) =>
    bytes.length >= offset + ascii.length
    && [...ascii].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, 'PNG')) return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'webp'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'gif'
  return undefined
}

const requireDep = createRequire(import.meta.url)

interface WebpDecoder {
  decode(source: Uint8Array): { width: number; height: number; data: Uint8ClampedArray }
}
interface GifReaderInstance {
  width: number
  height: number
  decodeAndBlitFrameRGBA(frame: number, pixels: Uint8Array): void
}
type GifReaderCtor = new (bytes: Uint8Array) => GifReaderInstance

let webp: WebpDecoder | undefined
let GifReader: GifReaderCtor | undefined

function encodeRgba(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Buffer {
  const png = new PNG({ width, height })
  png.data.set(rgba.subarray(0, width * height * 4))
  return PNG.sync.write(png)
}

/**
 * Convert any supported image to PNG bytes. PNG input passes through
 * untouched (keeping any embedded text chunks).
 * @throws when the format is unrecognized or the image fails to decode.
 */
export function toPng(bytes: Uint8Array): Buffer {
  const format = sniffImageFormat(bytes)
  try {
    switch (format) {
      case 'png':
        return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      case 'jpeg': {
        const decoded = decodeJpeg(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 512 })
        return encodeRgba(decoded.width, decoded.height, decoded.data)
      }
      case 'webp': {
        webp ??= requireDep('@cwasm/webp') as WebpDecoder
        const decoded = webp.decode(bytes)
        return encodeRgba(decoded.width, decoded.height, decoded.data)
      }
      case 'gif': {
        GifReader ??= (requireDep('omggif') as { GifReader: GifReaderCtor }).GifReader
        const reader = new GifReader(bytes)
        const pixels = new Uint8Array(reader.width * reader.height * 4)
        reader.decodeAndBlitFrameRGBA(0, pixels)
        return encodeRgba(reader.width, reader.height, pixels)
      }
      case undefined:
        break
    }
  } catch (error) {
    throw new Error(`图片解码失败（${format?.toUpperCase()}）：${error instanceof Error ? error.message : String(error)}`)
  }
  throw new Error(`无法识别的图片格式（按文件内容判断），支持 ${SUPPORTED_IMAGE_FORMATS}`)
}
