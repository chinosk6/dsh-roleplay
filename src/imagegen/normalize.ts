/**
 * Reference-image canvas normalization for the NovelAI director-reference
 * path. The API only accepts three canvas sizes — a raw upload answers
 * "Error encoding v4 director references: 400" — so the image is scaled to
 * fit and centered on an opaque black canvas:
 *   aspect >= 1.5   -> 1536x1024
 *   aspect <= 2/3   -> 1024x1536
 *   otherwise       -> 1472x1472
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
