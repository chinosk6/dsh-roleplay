/** Typed fetch helpers over the plugin's same-origin HTTP surface. */

/** Which store an item lives in. */
export type StoreScope = 'global' | 'workspace'

export interface CardSummary {
  id: string
  name: string
  description: string
  creatorNotes: string
  tags: string[]
  favorite: boolean
  updatedAt: number
  avatarUrl: string | null
  bookEntries: number
  scope: StoreScope
}

export type ReferenceMode = 'none' | 'avatar' | 'custom'

/** Card-carried regex script (the client applies the display-coloring subset). */
export interface RegexScriptValue {
  name: string
  find: string
  replace: string
  flags: string
  enabled: boolean
  markdownOnly: boolean
  promptOnly: boolean
  placement: number[]
}

export interface SessionState {
  binding: {
    mode: string
    characterId?: string
    autoImage?: boolean
    choiceMode?: boolean
    imageCount?: number
    referenceMode?: ReferenceMode
    pendingInstruction?: string
    workspacePath?: string
  } | null
  card: { id: string; name: string; firstMessage: string; avatarUrl: string | null; regexScripts: RegexScriptValue[]; updatedAt: number } | null
  autoImageDefault: boolean
  choiceModeDefault: boolean
  imageCountDefault: number
  referenceModeDefault: ReferenceMode
  hasSessionReference: boolean
}

export interface LoreEntryValue {
  id: string
  title: string
  content: string
  keys: string[]
  useRegex: boolean
  constant: boolean
  position: 'system_top' | 'before_char' | 'after_char' | 'user_top' | 'assistant_top' | 'at_depth'
  order: number
  depth: number
  scanDepth: number
  probability: number
  enabled: boolean
}

export interface CharacterCardDetail {
  card: {
    id: string
    name: string
    description: string
    personality: string
    scenario: string
    firstMessage: string
    exampleDialogs: string
    creatorNotes: string
    tags: string[]
    book: LoreEntryValue[]
    regexScripts: RegexScriptValue[]
    avatar?: string
    favorite: boolean
    createdAt: number
    updatedAt: number
  }
  avatarUrl: string | null
}


export type ImageSizeValue = 'portrait' | 'landscape' | 'square' | 'ratio43' | 'ratio169' | 'ratio34' | 'ratio916'

export interface RoleplaySettingsValue {
  userName: string
  userPersona: string
  workspaceSubfolder: string
  imageStore: StoreScope
  cardStore: StoreScope
  imageProvider: 'none' | 'novelai' | 'sdwebui' | 'url' | 'erpsex'
  novelaiApiUrl: string
  novelaiApiKey: string
  novelaiModel: string
  sdwebuiBaseUrl: string
  sdwebuiSteps: number
  sdwebuiCfgScale: number
  sdwebuiSampler: string
  urlTemplate: string
  erpsexApiKey: string
  erpsexModel: string
  stylePrompt: string
  negativePrompt: string
  imageSize: ImageSizeValue
  imageCount: number
  autoImage: boolean
  imageAggressiveness: 'conservative' | 'active' | 'force'
  referenceMode: 'none' | 'avatar' | 'custom'
  referenceStrength: number
  choiceMode: boolean
  choiceCount: number
}

export interface ErpPoints {
  points: number
  frozenPoints: number
  username?: string
}

const BASE = '/x-roleplay'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}${path}`, init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

/** Append the current-workspace query (store-aware routes). */
function withWs(path: string, ws?: string): string {
  if (!ws) return path
  return `${path}${path.includes('?') ? '&' : '?'}ws=${encodeURIComponent(ws)}`
}

export const api = {
  settings: () => request<{ value: RoleplaySettingsValue; imageProvider: { provider: string; available: boolean } }>('/settings'),
  updateSettings: (patch: Partial<RoleplaySettingsValue>) =>
    request<{ value: RoleplaySettingsValue }>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  cards: (ws?: string) => request<{ cards: CardSummary[] }>(withWs('/cards', ws)),
  deleteCard: (id: string, ws?: string) => request<{ deleted: boolean }>(withWs(`/cards/${id}`, ws), { method: 'DELETE' }),
  updateCard: (id: string, patch: object, ws?: string) =>
    request<{ card: unknown }>(withWs(`/cards/${id}`, ws), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  getCard: (id: string, ws?: string) => request<CharacterCardDetail>(withWs(`/cards/${id}`, ws)),
  moveCard: (id: string, to: StoreScope, ws?: string) =>
    request<{ card: unknown; scope: StoreScope }>(withWs(`/cards/${id}/move`, ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    }),
  updateCardAvatar: (id: string, bytes: ArrayBuffer, ws?: string) =>
    request<{ card: unknown; avatarUrl: string | null }>(withWs(`/cards/${id}/avatar`, ws), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  deleteCardAvatar: (id: string, ws?: string) =>
    request<{ card: unknown; avatarUrl: null }>(withWs(`/cards/${id}/avatar`, ws), { method: 'DELETE' }),
  importCard: (bytes: ArrayBuffer, ws?: string) =>
    request<{ card: { id: string; name: string }; scope: StoreScope }>(withWs('/cards/import', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  session: (sessionId: string) => request<SessionState>(`/session/${encodeURIComponent(sessionId)}`),
  updateSession: (sessionId: string, patch: {
    mode?: string
    characterId?: string | null
    autoImage?: boolean
    choiceMode?: boolean
    /** null clears the override back to the global setting. */
    imageCount?: number | null
    /** null clears the override back to the global setting. */
    referenceMode?: ReferenceMode | null
    /** One-shot stage direction sent with the next message; null clears it. */
    pendingInstruction?: string | null
    /** The session's workspace path (recorded by the dock); null forgets it. */
    workspacePath?: string | null
  }) =>
    request<{ binding: unknown }>(`/session/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  uploadSessionReference: (sessionId: string, bytes: ArrayBuffer) =>
    request<{ ok: boolean }>(`/session/${encodeURIComponent(sessionId)}/reference`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  deleteSessionReference: (sessionId: string) =>
    request<{ ok: boolean }>(`/session/${encodeURIComponent(sessionId)}/reference`, { method: 'DELETE' }),
  sessionReferenceUrl: (sessionId: string) => `${BASE}/session/${encodeURIComponent(sessionId)}/reference`,
  exportJsonUrl: (id: string, ws?: string) => `${BASE}${withWs(`/cards/${id}/export.json`, ws)}`,
  exportPngUrl: (id: string, ws?: string) => `${BASE}${withWs(`/cards/${id}/export.png`, ws)}`,
  uploadReference: (bytes: ArrayBuffer) =>
    request<{ ok: boolean }>('/settings/reference', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  referenceUrl: () => `${BASE}/settings/reference`,
  erpPoints: () => request<ErpPoints>('/erp/points'),
  images: (ws?: string) => request<GalleryResponse>(withWs('/images', ws)),
  starImage: (id: string, starred: boolean, ws?: string) =>
    request<{ ok: boolean }>(withWs('/images/star', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, starred }),
    }),
  deleteImages: (ids: string[], ws?: string) =>
    request<{ deleted: number }>(withWs('/images/delete', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  moveImages: (ids: string[], to: StoreScope, ws?: string) =>
    request<{ moved: number }>(withWs('/images/move', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, to }),
    }),
  imageStates: (ids: string[], ws?: string) =>
    request<{ states: Record<string, ImageGenState> }>(withWs(`/images/state?ids=${ids.map(encodeURIComponent).join(',')}`, ws)),
  regenerateImages: (ids: string[], ws?: string) =>
    request<{ regenerated: string[] }>(withWs('/images/regenerate', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  probeWorkspaceFolder: (ws: string, sub: string) =>
    request<{ exists: boolean }>(withWs(`/workspace/probe?sub=${encodeURIComponent(sub)}`, ws)),
  migrateWorkspaceFolder: (ws: string, from: string, to: string) =>
    request<{ moved: boolean }>(withWs('/workspace/migrate', ws), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    }),
}

export interface ImageGenState {
  status: 'ready' | 'pending' | 'failed'
  error?: string
}

export interface GalleryImage {
  id: string
  prompt: string
  provider: string
  width?: number
  height?: number
  createdAt: number
  starred: boolean
  size: number
  url: string
  scope: StoreScope
}

export interface GalleryUsage {
  usedBytes: number
  freeBytes: number
  totalBytes: number
  /** Present only when the workspace store sits on a different partition. */
  wsFreeBytes?: number
  wsTotalBytes?: number
}

export interface GalleryResponse {
  images: GalleryImage[]
  usage: GalleryUsage
}

/**
 * Cache-bust a stored-file URL with a content stamp (e.g. the card's
 * updatedAt): avatar files are overwritten IN PLACE under a fixed name, so an
 * unchanged src would keep showing the browser-cached old image.
 */
export function stampedUrl(url: string, stamp: number | undefined): string {
  if (!stamp) return url
  return `${url}${url.includes('?') ? '&' : '?'}t=${stamp}`
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 2 ** (10 * exponent)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}
