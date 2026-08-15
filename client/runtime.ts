/**
 * Module-level bridge between the plugin's apply() (which owns the client
 * Cordis context) and its React components (which the slot renderer mounts
 * without ctx access): the sessions/slots services, the rewind flow, and a
 * tiny revision bus that lets image cards refresh after an in-place
 * regeneration.
 */
import { api } from './api.ts'

interface SessionsFace {
  fork(opts: { sessionId: string; atSeq?: number }): Promise<string>
  select(sessionId: string): void
}

interface WorkspacesFace {
  archiveSession(sessionId: string): Promise<void>
}

interface SlotsFace {
  entries(key: string): readonly { component: unknown; options: { key?: string; priority?: number } }[]
}

let sessionsFace: SessionsFace | undefined
let workspacesFace: WorkspacesFace | undefined
let slotsFace: SlotsFace | undefined

export function wireRuntime(services: { sessions: SessionsFace; workspaces: WorkspacesFace; slots: SlotsFace }): void {
  sessionsFace = services.sessions
  workspacesFace = services.workspaces
  slotsFace = services.slots
}

/** The native (non-plugin) component registered for one keyed chat-node cell. */
export function nativeChatNodeComponent(key: string, own: unknown): unknown {
  const rows = slotsFace?.entries('conversation.chat.node') ?? []
  const cell = rows
    .filter(row => row.options.key === key && row.component !== own)
    .sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
  return cell[0]?.component
}

// ── rewind & resend ──────────────────────────────────────────────────────────

/** Draft staged for a freshly forked session, consumed by its dock on mount. */
const pendingResend = new Map<string, string>()

export function takeResend(sessionId: string): string | undefined {
  const text = pendingResend.get(sessionId)
  if (text !== undefined) pendingResend.delete(sessionId)
  return text
}

/**
 * Rewind the conversation in place: fork the session at the previous turn's
 * end (the append-only log's rewrite primitive), carry the role-play binding
 * over, stage `resendText` for the fork's dock, switch to the fork, and
 * ARCHIVE the original — the visible session list keeps exactly one
 * conversation, edited from that point on.
 * @param prevTurnEndSeq - `turn/end` seq of the turn BEFORE the one being replaced.
 */
export async function rewindAndResend(sessionId: string, prevTurnEndSeq: number, resendText: string): Promise<void> {
  if (!sessionsFace) throw new Error('roleplay runtime not wired')
  const state = await api.session(sessionId).catch(() => null)
  const forkedId = await sessionsFace.fork({ sessionId, atSeq: prevTurnEndSeq })
  const binding = state?.binding
  if (binding) {
    await api.updateSession(forkedId, {
      mode: binding.mode,
      ...(binding.characterId !== undefined ? { characterId: binding.characterId } : {}),
      ...(binding.autoImage !== undefined ? { autoImage: binding.autoImage } : {}),
      ...(binding.choiceMode !== undefined ? { choiceMode: binding.choiceMode } : {}),
      ...(binding.imageCount !== undefined ? { imageCount: binding.imageCount } : {}),
      ...(binding.referenceMode !== undefined ? { referenceMode: binding.referenceMode } : {}),
    }).catch(() => {})
  }
  if (resendText.trim() !== '') pendingResend.set(forkedId, resendText)
  sessionsFace.select(forkedId)
  await workspacesFace?.archiveSession(sessionId).catch(() => {})
}

// ── image revision bus ───────────────────────────────────────────────────────

const imageRevs = new Map<string, number>()
const revListeners = new Set<() => void>()

export function bumpImageRevs(ids: string[]): void {
  for (const id of ids) imageRevs.set(id, (imageRevs.get(id) ?? 0) + 1)
  for (const listener of revListeners) listener()
}

export function imageRev(id: string): number {
  return imageRevs.get(id) ?? 0
}

export function subscribeImageRevs(listener: () => void): () => void {
  revListeners.add(listener)
  return () => revListeners.delete(listener)
}

/** Cache-busted variant of a stored image URL (rev 0 = the original URL). */
export function imageUrlWithRev(url: string, id: string): string {
  const rev = imageRev(id)
  return rev === 0 ? url : `${url}?r=${rev}`
}
