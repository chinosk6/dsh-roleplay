/**
 * Minimal PNG text-chunk codec: read and write `tEXt` / `iTXt` chunks so
 * character data can travel inside an ordinary portrait PNG. Standard PNG
 * layout: 8-byte signature, then chunks of [length u32][type 4B][data][crc u32].
 */

import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(...parts: Buffer[]): number {
  let crc = 0xffffffff
  for (const part of parts) {
    for (const byte of part) crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0
  }
  return (crc ^ 0xffffffff) >>> 0
}

export function isPng(bytes: Buffer): boolean {
  return bytes.length > 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)
}

interface Chunk {
  type: string
  data: Buffer
  /** Offset of the chunk's length field within the file. */
  start: number
  /** Offset one past the chunk's CRC. */
  end: number
}

function* chunks(bytes: Buffer): Generator<Chunk> {
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    const end = offset + 12 + length
    if (end > bytes.length) return
    yield { type, data: bytes.subarray(offset + 8, offset + 8 + length), start: offset, end }
    if (type === 'IEND') return
    offset = end
  }
}

/** All textual key/value pairs from tEXt and uncompressed iTXt chunks. */
export function readTextChunks(bytes: Buffer): Map<string, string> {
  const out = new Map<string, string>()
  if (!isPng(bytes)) return out
  for (const chunk of chunks(bytes)) {
    if (chunk.type === 'tEXt') {
      const sep = chunk.data.indexOf(0)
      if (sep <= 0) continue
      out.set(chunk.data.toString('latin1', 0, sep), chunk.data.toString('latin1', sep + 1))
    } else if (chunk.type === 'iTXt') {
      const sep = chunk.data.indexOf(0)
      if (sep <= 0 || sep + 2 >= chunk.data.length) continue
      const compressed = chunk.data[sep + 1]
      if (compressed !== 0) continue
      // keyword \0 compressionFlag compressionMethod \0 languageTag \0 translatedKeyword \0 text
      let cursor = sep + 3
      for (let fields = 0; fields < 2 && cursor < chunk.data.length; fields++) {
        cursor = chunk.data.indexOf(0, cursor) + 1
        if (cursor === 0) { cursor = chunk.data.length; break }
      }
      out.set(chunk.data.toString('latin1', 0, sep), chunk.data.toString('utf8', cursor))
    }
  }
  return out
}

function buildTextChunk(keyword: string, text: string): Buffer {
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])
  const type = Buffer.from('tEXt', 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(type, data))
  return Buffer.concat([length, type, data, crc])
}

/**
 * Return a copy of the PNG with the given text chunks inserted right after
 * IHDR. Existing chunks bearing the same keywords are removed first, so a
 * re-export never accumulates stale payloads.
 */
export function writeTextChunks(bytes: Buffer, entries: Record<string, string>): Buffer {
  if (!isPng(bytes)) throw new Error('not a PNG file')
  const keep: Buffer[] = [PNG_SIGNATURE]
  let inserted = false
  for (const chunk of chunks(bytes)) {
    if (chunk.type === 'tEXt' || chunk.type === 'iTXt') {
      const sep = chunk.data.indexOf(0)
      const keyword = sep > 0 ? chunk.data.toString('latin1', 0, sep) : ''
      if (keyword in entries) continue
    }
    keep.push(bytes.subarray(chunk.start, chunk.end))
    if (!inserted && chunk.type === 'IHDR') {
      for (const [keyword, text] of Object.entries(entries)) keep.push(buildTextChunk(keyword, text))
      inserted = true
    }
  }
  if (!inserted) throw new Error('PNG has no IHDR chunk')
  return Buffer.concat(keep)
}

function buildChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'latin1')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeBytes, data))
  return Buffer.concat([length, typeBytes, data, crc])
}

/** Encode a solid-color PNG, used as the export canvas when a card has no portrait. */
export function encodeSolidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // color type: truecolor
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) {
    row[1 + x * 3] = rgb[0]
    row[2 + x * 3] = rgb[1]
    row[3 + x * 3] = rgb[2]
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    PNG_SIGNATURE,
    buildChunk('IHDR', ihdr),
    buildChunk('IDAT', deflateSync(raw)),
    buildChunk('IEND', Buffer.alloc(0)),
  ])
}
