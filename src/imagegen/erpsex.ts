/**
 * ai.erp.sex backend — a hosted image-generation gateway. Flow:
 * POST /api/image_gen (points deducted, returns taskId) → poll
 * GET /api/image_gen/{taskId} every ~3s until success/failed. A success
 * payload is served exactly ONCE, so the poller saves it immediately.
 * Points balance comes from GET /api/me.
 *
 * Model selection rides on the wire field `type`: "nai" (server-side
 * nai-diffusion-4-5-full), "banana", "banana pro", "grok", "wai illustrious".
 * The settings expose a free-form model name; anything nai-* collapses to
 * "nai", everything else is passed through verbatim.
 */
import type { ImageProvider, ImageRequest } from './types.ts'
import { normalizeDirectorReference } from './normalize.ts'

export const ERPSEX_ORIGIN = 'https://ai.erp.sex'
const POLL_INTERVAL_MS = 3000
const POLL_TIMEOUT_MS = 5 * 60 * 1000

export interface ErpSexPoints {
  points: number
  frozenPoints: number
  username?: string
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
}

async function readError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(text) as { error?: string }
    if (typeof parsed.error === 'string') return parsed.error
  } catch {
    // fall through to raw text
  }
  return text.slice(0, 300)
}

/** Query the account's points balance. */
export async function fetchErpSexPoints(apiKey: string, signal?: AbortSignal): Promise<ErpSexPoints> {
  const response = await fetch(`${ERPSEX_ORIGIN}/api/me`, { headers: authHeaders(apiKey), signal: signal ?? null })
  if (!response.ok) throw new Error(`点数查询失败（HTTP ${response.status}）：${await readError(response)}`)
  const body = (await response.json()) as { points?: number; frozenPoints?: number; username?: string }
  return {
    points: typeof body.points === 'number' ? body.points : 0,
    frozenPoints: typeof body.frozenPoints === 'number' ? body.frozenPoints : 0,
    ...(typeof body.username === 'string' ? { username: body.username } : {}),
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('生成已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Collapse the user-facing model name onto the API's `type` value. */
export function erpSexTypeOf(model: string): string {
  const trimmed = model.trim()
  if (trimmed === '' || /^nai([-_.\s]|$)/i.test(trimmed)) return 'nai'
  return trimmed
}

export function createErpSexProvider(config: () => { apiKey: string; model: string }): ImageProvider {
  return {
    id: 'erpsex',
    available: () => config().apiKey.trim() !== '',
    async generate(request: ImageRequest): Promise<Buffer> {
      const { apiKey: rawKey, model } = config()
      const apiKey = rawKey.trim()
      const type = erpSexTypeOf(model)
      // The gateway takes references as bare base64 PNGs (no data: prefix).
      // For the nai type, pre-normalizing onto a director canvas is required;
      // other types take the original image as-is.
      let reference: string | undefined
      if (request.reference) {
        try {
          reference = type === 'nai'
            ? normalizeDirectorReference(request.reference).toString('base64')
            : request.reference.toString('base64')
        } catch {
          reference = undefined
        }
      }
      const start = await fetch(`${ERPSEX_ORIGIN}/api/image_gen`, {
        method: 'POST',
        headers: authHeaders(apiKey),
        body: JSON.stringify({
          type,
          prompts: request.prompt.slice(0, 5000),
          // note: the wire field is spelled aspectRadio by the API
          aspectRadio: request.aspect ?? '3:4',
          refImages: reference ? [reference] : [],
        }),
        signal: request.signal ?? null,
      })
      if (!start.ok) throw new Error(`生成请求失败（HTTP ${start.status}）：${await readError(start)}`)
      const receipt = (await start.json()) as { taskId?: string }
      if (!receipt.taskId) throw new Error('生成接口没有返回 taskId')

      const deadline = Date.now() + POLL_TIMEOUT_MS
      for (;;) {
        await sleep(POLL_INTERVAL_MS, request.signal)
        if (Date.now() > deadline) throw new Error('生成超时（5 分钟）')
        const poll = await fetch(`${ERPSEX_ORIGIN}/api/image_gen/${receipt.taskId}`, {
          headers: authHeaders(apiKey),
          signal: request.signal ?? null,
        })
        if (poll.status === 404) throw new Error('生成任务丢失（结果只能领取一次或任务已过期）')
        if (!poll.ok) throw new Error(`任务查询失败（HTTP ${poll.status}）：${await readError(poll)}`)
        const state = (await poll.json()) as { status?: string; images?: string[]; error?: string }
        if (state.status === 'failed') throw new Error(`生成失败：${state.error ?? '未知原因（点数已退回）'}`)
        if (state.status === 'success') {
          const first = state.images?.[0]
          if (!first) throw new Error('生成成功但没有返回图片')
          const base64 = first.startsWith('data:') ? first.slice(first.indexOf(',') + 1) : first
          return Buffer.from(base64, 'base64')
        }
      }
    },
  }
}
