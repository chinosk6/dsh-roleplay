/**
 * Reference-image canvas normalization for the NovelAI director-reference
 * path. The v4 API only accepts three canvas sizes — a raw upload answers
 * "Error encoding v4 director references: 400" — so the image is scaled to
 * fit and centered on an opaque black canvas:
 *   aspect >= 1.5   -> 1536x1024
 *   aspect <= 2/3   -> 1024x1536
 *   otherwise       -> 1472x1472
 * v5 instead cover-crops onto one of 97 ~1MP canvases (normalizeV5Reference).
 */
import { PNG } from 'pngjs'

/** Bilinear-sample one RGBA channel set from the source at (sx, sy). */
function sample(src: PNG, sx: number, sy: number, out: [number, number, number, number]): void {
  const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)))
  const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)))
  const x1 = Math.min(src.width - 1, x0 + 1)
  const y1 = Math.min(src.height - 1, y0 + 1)
  const fx = Math.max(0, Math.min(1, sx - x0))
  const fy = Math.max(0, Math.min(1, sy - y0))
  for (let channel = 0; channel < 4; channel++) {
    const p00 = src.data[(y0 * src.width + x0) * 4 + channel]!
    const p10 = src.data[(y0 * src.width + x1) * 4 + channel]!
    const p01 = src.data[(y1 * src.width + x0) * 4 + channel]!
    const p11 = src.data[(y1 * src.width + x1) * 4 + channel]!
    const top = p00 + (p10 - p00) * fx
    const bottom = p01 + (p11 - p01) * fx
    out[channel] = top + (bottom - top) * fy
  }
}

/** Normalize a PNG to a director-reference canvas; returns PNG bytes. */
export function normalizeDirectorReference(png: Buffer): Buffer {
  const src = PNG.sync.read(png)
  if (src.width <= 0 || src.height <= 0) throw new Error('reference image has no pixels')
  const ratio = src.width / src.height
  let canvasWidth = 1472
  let canvasHeight = 1472
  if (ratio >= 1.5) {
    canvasWidth = 1536
    canvasHeight = 1024
  } else if (ratio <= 2 / 3) {
    canvasWidth = 1024
    canvasHeight = 1536
  }
  const scale = Math.min(canvasWidth / src.width, canvasHeight / src.height)
  const drawWidth = Math.max(1, Math.round(src.width * scale))
  const drawHeight = Math.max(1, Math.round(src.height * scale))
  const offsetX = Math.floor((canvasWidth - drawWidth) / 2)
  const offsetY = Math.floor((canvasHeight - drawHeight) / 2)

  const out = new PNG({ width: canvasWidth, height: canvasHeight })
  // Opaque black ground (matches the drawing canvas the format expects).
  for (let i = 0; i < out.data.length; i += 4) out.data[i + 3] = 255

  const pixel: [number, number, number, number] = [0, 0, 0, 0]
  for (let y = 0; y < drawHeight; y++) {
    const sy = (y + 0.5) / scale - 0.5
    for (let x = 0; x < drawWidth; x++) {
      const sx = (x + 0.5) / scale - 0.5
      sample(src, sx, sy, pixel)
      const alpha = pixel[3] / 255
      const offset = ((y + offsetY) * canvasWidth + (x + offsetX)) * 4
      // Composite over black: color * alpha.
      out.data[offset] = Math.round(pixel[0] * alpha)
      out.data[offset + 1] = Math.round(pixel[1] * alpha)
      out.data[offset + 2] = Math.round(pixel[2] * alpha)
      out.data[offset + 3] = 255
    }
  }
  return PNG.sync.write(out)
}

/**
 * The 97 canvases NAI v5 cuts a Precise Reference to: about one megapixel,
 * sides in multiples of 64, from 256x4096 through 1024x1024 to 4096x256.
 */
const V5_REFERENCE_SIZES: readonly (readonly [number, number])[] = (() => {
  const tall: [number, number][] = []
  for (let height = 4096; height >= 1024; height -= 64) {
    tall.push([Math.floor(Math.floor((1024 * 1024) / height) / 64) * 64, height])
  }
  const wide = tall.slice(0, -1).reverse().map(([width, height]): [number, number] => [height, width])
  return [...tall, ...wide]
})()

/** The v5 reference canvas closest in shape (by log aspect ratio) to `width`x`height`. */
export function v5ReferenceSize(width: number, height: number): readonly [number, number] {
  const target = Math.log(width / height)
  let best = V5_REFERENCE_SIZES[0]!
  for (const size of V5_REFERENCE_SIZES) {
    if (Math.abs(target - Math.log(size[0] / size[1])) < Math.abs(target - Math.log(best[0] / best[1]))) best = size
  }
  return best
}

const STEALTH_MARKER = 'stealth_pngcomp'

/**
 * NovelAI hides the generation settings in the lowest alpha bit (one bit per
 * pixel, running down the columns), which leaves its own outputs faintly
 * transparent. Since the v5 reference keeps its alpha channel, an image that
 * carries the marker gets the same cleanup NovelAI's site applies before use:
 * alpha 254 -> 255 and 1 -> 0.
 * @returns whether the image carried hidden data (and was changed).
 */
function scrubStealthAlpha(image: PNG): boolean {
  const { width, height, data } = image
  if (width * height < STEALTH_MARKER.length * 8) return false
  for (let index = 0; index < STEALTH_MARKER.length; index++) {
    let value = 0
    for (let bit = index * 8; bit < index * 8 + 8; bit++) {
      const x = Math.floor(bit / height)
      const y = bit % height
      value = (value << 1) | (data[(y * width + x) * 4 + 3]! & 1)
    }
    if (value !== STEALTH_MARKER.charCodeAt(index)) return false
  }
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 254) data[i] = 255
    else if (data[i] === 1) data[i] = 0
  }
  return true
}

/**
 * Normalize a PNG for the NAI v5 Precise Reference path: scale it to cover the
 * closest v5 reference canvas and center-crop the overflow. Unlike the v4
 * canvases there is no padding, and transparency is kept.
 * @returns PNG bytes (the input itself when it already fits).
 */
export function normalizeV5Reference(png: Buffer): Buffer {
  const src = PNG.sync.read(png)
  if (src.width <= 0 || src.height <= 0) throw new Error('reference image has no pixels')
  const scrubbed = scrubStealthAlpha(src)
  const [width, height] = v5ReferenceSize(src.width, src.height)
  if (!scrubbed && src.width === width && src.height === height) return png
  const scale = Math.max(width / src.width, height / src.height)
  const offsetX = (src.width * scale - width) / 2
  const offsetY = (src.height * scale - height) / 2
  const out = new PNG({ width, height })
  for (let y = 0; y < height; y++) {
    const sy = (y + offsetY + 0.5) / scale - 0.5
    const y0 = Math.max(0, Math.min(src.height - 1, Math.floor(sy)))
    const y1 = Math.min(src.height - 1, y0 + 1)
    const fy = Math.max(0, Math.min(1, sy - y0))
    for (let x = 0; x < width; x++) {
      const sx = (x + offsetX + 0.5) / scale - 0.5
      const x0 = Math.max(0, Math.min(src.width - 1, Math.floor(sx)))
      const x1 = Math.min(src.width - 1, x0 + 1)
      const fx = Math.max(0, Math.min(1, sx - x0))
      // Bilinear with color weighted by alpha, so the (arbitrary) color of
      // transparent neighbours does not bleed into the kept edge pixels.
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let corner = 0; corner < 4; corner++) {
        const at = ((corner < 2 ? y0 : y1) * src.width + (corner % 2 === 0 ? x0 : x1)) * 4
        const weight = (corner % 2 === 0 ? 1 - fx : fx) * (corner < 2 ? 1 - fy : fy) * src.data[at + 3]!
        red += src.data[at]! * weight
        green += src.data[at + 1]! * weight
        blue += src.data[at + 2]! * weight
        alpha += weight
      }
      const offset = (y * width + x) * 4
      if (alpha > 0) {
        out.data[offset] = Math.round(red / alpha)
        out.data[offset + 1] = Math.round(green / alpha)
        out.data[offset + 2] = Math.round(blue / alpha)
      }
      out.data[offset + 3] = Math.round(alpha)
    }
  }
  return PNG.sync.write(out)
}

/**
 * Cover-fit a PNG onto an exact `width`x`height` canvas (scale to fill,
 * center-crop the overflow); returns PNG bytes. img2img sources must match
 * the requested output size.
 */
export function coverToCanvas(png: Buffer, width: number, height: number): Buffer {
  const src = PNG.sync.read(png)
  if (src.width <= 0 || src.height <= 0) throw new Error('reference image has no pixels')
  if (src.width === width && src.height === height) return png
  const scale = Math.max(width / src.width, height / src.height)
  const offsetX = (src.width * scale - width) / 2
  const offsetY = (src.height * scale - height) / 2
  const out = new PNG({ width, height })
  const pixel: [number, number, number, number] = [0, 0, 0, 0]
  for (let y = 0; y < height; y++) {
    const sy = (y + offsetY + 0.5) / scale - 0.5
    for (let x = 0; x < width; x++) {
      const sx = (x + offsetX + 0.5) / scale - 0.5
      sample(src, sx, sy, pixel)
      const alpha = pixel[3] / 255
      const offset = (y * width + x) * 4
      out.data[offset] = Math.round(pixel[0] * alpha)
      out.data[offset + 1] = Math.round(pixel[1] * alpha)
      out.data[offset + 2] = Math.round(pixel[2] * alpha)
      out.data[offset + 3] = 255
    }
  }
  return PNG.sync.write(out)
}
