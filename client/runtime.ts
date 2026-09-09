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
  /** Session rows plus the current selection (both dsh generations expose it). */
  list?: {
    getSnapshot(): { current?: string | undefined }
    subscribe(fn: () => void): () => void
  }
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
 * The workspace the user is working in right now — the store target for the
 * settings page, the gallery and the forge card editor.
 *
 * Resolution order: the workspace accounting the CURRENT session (the only
 * answer dsh 0.1.2 still allows — its workspace snapshot dropped the
 * `recentWorkspaceId` projection), then that projection where an older
 * harness still publishes it, and only then the first registered workspace.
 * Without the session step, 0.1.2 always fell through to that last resort and
 * every store operation silently targeted the first workspace in the list.
 *
 * Returns a REFERENCE-STABLE object while the workspace is unchanged
 * (useSyncExternalStore snapshot contract).
 */
let lastCurrent: WorkspaceInfo | undefined
export function currentWorkspace(): WorkspaceInfo | undefined {
  const state = workspacesFace?.list?.getSnapshot()
  const openSessionId = sessionsFace?.list?.getSnapshot().current
  const row = state
    ? ((openSessionId !== undefined
        ? state.items.find(item => item.sessionIds.includes(openSessionId))
        : undefined)
      ?? (state.recentWorkspaceId !== undefined
        ? state.items.find(item => item.workspaceId === state.recentWorkspaceId)
        : undefined)
      ?? state.items[0])
    : undefined
  if (!row) {
    lastCurrent = undefined
  } else if (!lastCurrent || lastCurrent.workspaceId !== row.workspaceId || lastCurrent.path !== row.path || lastCurrent.title !== row.title) {
    lastCurrent = { workspaceId: row.workspaceId, path: row.path, title: row.title }
  }
  return lastCurrent
}

/**
 * Subscribe to everything {@link currentWorkspace} reads: the workspace list
 * AND the session selection (switching conversations changes the answer).
 */
export function subscribeWorkspaces(fn: () => void): () => void {
  const stopWorkspaces = workspacesFace?.list?.subscribe(fn)
  const stopSessions = sessionsFace?.list?.subscribe(fn)
  return () => {
    stopWorkspaces?.()
    stopSessions?.()
  }
}

/**
 * The native (non-plugin) component registered for one keyed slot cell, so a
 * shadow that only wants to CHANGE some cases can hand the rest back
 * untouched. Keyed shadowing is process-global; delegation is what keeps a
 * global takeover inert wherever the plugin has nothing to add.
 */
export function nativeKeyedComponent(slot: string, key: string, own: unknown): unknown {
  const rows = slotsFace?.entries(slot) ?? []
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
