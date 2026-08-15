/** Typed fetch helpers over the plugin's same-origin HTTP surface. */

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
  } | null
  card: { id: string; name: string; firstMessage: string; avatarUrl: string | null; regexScripts: RegexScriptValue[] } | null
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

export const api = {
  settings: () => request<{ value: RoleplaySettingsValue; imageProvider: { provider: string; available: boolean } }>('/settings'),
  updateSettings: (patch: Partial<RoleplaySettingsValue>) =>
    request<{ value: RoleplaySettingsValue }>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  cards: () => request<{ cards: CardSummary[] }>('/cards'),
  deleteCard: (id: string) => request<{ deleted: boolean }>(`/cards/${id}`, { method: 'DELETE' }),
  updateCard: (id: string, patch: object) =>
    request<{ card: unknown }>(`/cards/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  getCard: (id: string) => request<CharacterCardDetail>(`/cards/${id}`),
  updateCardAvatar: (id: string, bytes: ArrayBuffer) =>
    request<{ card: unknown; avatarUrl: string | null }>(`/cards/${id}/avatar`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  deleteCardAvatar: (id: string) =>
    request<{ card: unknown; avatarUrl: null }>(`/cards/${id}/avatar`, { method: 'DELETE' }),
  importCard: (bytes: ArrayBuffer) =>
    request<{ card: { id: string; name: string } }>('/cards/import', {
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
  exportJsonUrl: (id: string) => `${BASE}/cards/${id}/export.json`,
  exportPngUrl: (id: string) => `${BASE}/cards/${id}/export.png`,
  uploadReference: (bytes: ArrayBuffer) =>
    request<{ ok: boolean }>('/settings/reference', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    }),
  referenceUrl: () => `${BASE}/settings/reference`,
  erpPoints: () => request<ErpPoints>('/erp/points'),
  images: () => request<GalleryResponse>('/images'),
  starImage: (id: string, starred: boolean) =>
    request<{ ok: boolean }>('/images/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, starred }),
    }),
  deleteImages: (ids: string[]) =>
    request<{ deleted: number }>('/images/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),
  imageStates: (ids: string[]) =>
    request<{ states: Record<string, ImageGenState> }>(`/images/state?ids=${ids.map(encodeURIComponent).join(',')}`),
  regenerateImages: (ids: string[]) =>
    request<{ regenerated: string[] }>('/images/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
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
}

export interface GalleryUsage {
  usedBytes: number
  freeBytes: number
  totalBytes: number
}

export interface GalleryResponse {
  images: GalleryImage[]
  usage: GalleryUsage
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const exponent = Math.min(units.length - 1, Math.floor(Math.log2(bytes) / 10))
  const value = bytes / 2 ** (10 * exponent)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`
}
