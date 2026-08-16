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
  /** Select a session as current (the ISessions face names this `open`). */
  open?(sessionId: string): void
  /** Older face spelling, kept as a fallback. */
  select?(sessionId: string): void
}

interface WorkspaceRow {
  workspaceId: string
  /** Canonical directory path of the workspace. */
  path: string
  title: string
  sessionIds: readonly string[]
}

interface WorkspacesFace {
  archiveSession(sessionId: string): Promise<void>
  /** Reorder an accounted session within its workspace (DOM-insertBefore-like). */
  insertSessionBefore?(workspaceId: string, sessionId: string, beforeSessionId?: string): Promise<unknown>
  /** The workspaces snapshot feed (present on the real ctx.workspaces). */
  list?: {
    getSnapshot(): { items: readonly WorkspaceRow[]; recentWorkspaceId?: string | undefined }
    subscribe(fn: () => void): () => void
  }
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

// ── workspace access ─────────────────────────────────────────────────────────

export interface WorkspaceInfo {
  workspaceId: string
  path: string
  title: string
}

function toInfo(row: WorkspaceRow | undefined): WorkspaceInfo | undefined {
  return row ? { workspaceId: row.workspaceId, path: row.path, title: row.title } : undefined
}

/** The workspace a session is accounted under. */
export function workspaceOfSession(sessionId: string): WorkspaceInfo | undefined {
  const state = workspacesFace?.list?.getSnapshot()
  return toInfo(state?.items.find(item => item.sessionIds.includes(sessionId)))
}

/**
 * The most recently active workspace — the "current" one outside any session
 * context. Returns a REFERENCE-STABLE object while the workspace is unchanged
 * (useSyncExternalStore snapshot contract).
 */
let lastRecent: WorkspaceInfo | undefined
export function recentWorkspace(): WorkspaceInfo | undefined {
  const state = workspacesFace?.list?.getSnapshot()
  const row = state
    ? (state.items.find(item => item.workspaceId === state.recentWorkspaceId) ?? state.items[0])
    : undefined
  if (!row) {
    lastRecent = undefined
  } else if (!lastRecent || lastRecent.workspaceId !== row.workspaceId || lastRecent.path !== row.path || lastRecent.title !== row.title) {
    lastRecent = { workspaceId: row.workspaceId, path: row.path, title: row.title }
  }
  return lastRecent
}

/** Subscribe to workspace list changes (no-op unsubscriber without the feed). */
export function subscribeWorkspaces(fn: () => void): () => void {
  return workspacesFace?.list?.subscribe(fn) ?? (() => {})
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
 * end (the append-only log's rewrite primitive — dsh has no truncate), carry
 * the role-play binding over, stage `resendText` for the fork's dock, switch
 * to the fork, and ARCHIVE the original. The fork INHERITS the durable title
 * (no increaseTitle) and is slotted into the original's exact list position
 * before the original disappears, so to the user this reads as editing the
 * current conversation — same title, same place, same prefix.
 * @param prevTurnEndSeq - `turn/end` seq of the turn BEFORE the one being replaced.
 */
export async function rewindAndResend(sessionId: string, prevTurnEndSeq: number, resendText: string): Promise<void> {
  if (!sessionsFace) throw new Error('roleplay runtime not wired')
  const warn = (...args: unknown[]) => console.warn('[dsh-roleplay] rewind:', ...args)
  const state = await api.session(sessionId).catch(() => null)
  const origin = workspaceOfSession(sessionId)
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
      ...(binding.workspacePath !== undefined ? { workspacePath: binding.workspacePath } : {}),
    }).catch(err => warn('binding copy failed', err))
  }
  // Take over the original's slot in the workspace list (fork attach prepends).
  if (origin) {
    await workspacesFace?.insertSessionBefore?.(origin.workspaceId, forkedId, sessionId)
      .catch(err => warn('insertSessionBefore failed', err))
  }
  if (resendText.trim() !== '') pendingResend.set(forkedId, resendText)
  // The ISessions face names selection `open` (older builds spelled it `select`).
  try {
    const openSession = sessionsFace.open ?? sessionsFace.select
    if (!openSession) throw new Error('sessions face exposes neither open nor select')
    openSession.call(sessionsFace, forkedId)
  } catch (error) {
    warn('open failed', error)
  }
  await workspacesFace?.archiveSession(sessionId)
    .catch(err => warn('archive failed', err))
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
  // Workspace-stored URLs already carry a ?ws= query — never emit a second '?'.
  return rev === 0 ? url : `${url}${url.includes('?') ? '&' : '?'}r=${rev}`
}
