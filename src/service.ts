/**
 * The `roleplay` service: character cards, per-session bindings, settings and
 * image generation, shared by the HTTP surface and the per-session agent
 * plugin.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { CharacterCard, GeneratedImage, SessionBinding } from './cards/types.ts'
import { cardFromInterchange, cardFromPng, cardToInterchange, cardToPng } from './cards/codec.ts'
import { encodeSolidPng, isPng } from './cards/png.ts'
import { RoleplaySettings } from './settings.ts'
import { createNovelAiProvider, fetchNovelAiPoints, type NovelAiPoints } from './imagegen/novelai.ts'
import { createSdWebUiProvider } from './imagegen/sdwebui.ts'
import { createUrlTemplateProvider } from './imagegen/urltemplate.ts'
import { createErpSexProvider, fetchErpSexPoints, type ErpSexPoints } from './imagegen/erpsex.ts'
import { aspectOf, dimensionsOf, type ImageProvider } from './imagegen/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    roleplay: RoleplayService
  }
}

const domainSpec = defineDomain({
  name: 'roleplay',
  version: 1,
  tables: {
    cards: domainTable<string, CharacterCard>(CharacterCard),
    sessions: domainTable<string, SessionBinding>(SessionBinding),
    images: domainTable<string, GeneratedImage>(GeneratedImage),
  },
})

export interface GeneratedImageRef {
  id: string
  /** Same-origin URL the web client renders. */
  url: string
  /** Output dimensions, known before generation — lets the client reserve an exactly-sized placeholder. */
  width: number
  height: number
}

/** Which store a card/image lives in: the global data dir, or the current workspace's subfolder. */
export type StoreScope = 'global' | 'workspace'

export class RoleplayService extends Service {
  readonly settings: SettingsScope<RoleplaySettings>
  private domain!: Domain<typeof domainSpec>
  private readonly dataDir: string
  private readonly providers: ImageProvider[]
  /** Serializes provider calls so remote backends never see parallel bursts. */
  private generationChain: Promise<unknown> = Promise.resolve()
  /** In-flight/failed background generations; an id absent here with a file on disk is ready. */
  private readonly imageTaskStates = new Map<string, { status: 'pending' | 'failed'; error?: string }>()

  constructor(ctx: Context, dataDir: string) {
    super(ctx, 'roleplay')
    this.dataDir = dataDir
    this.settings = ctx.settings.register(settingsNamespace('roleplay'), RoleplaySettings)
    const current = () => this.settings.get()
    this.providers = [
      createNovelAiProvider(() => ({
        apiUrl: current().novelaiApiUrl,
        apiKey: current().novelaiApiKey,
        model: current().novelaiModel,
      })),
      createSdWebUiProvider(() => ({
        baseUrl: current().sdwebuiBaseUrl,
        steps: current().sdwebuiSteps,
        cfgScale: current().sdwebuiCfgScale,
        sampler: current().sdwebuiSampler,
      })),
      createUrlTemplateProvider(() => current().urlTemplate),
      createErpSexProvider(() => ({ apiKey: current().erpsexApiKey, model: current().erpsexModel })),
    ]
  }

  /** Points balance of the hosted wrapper backend account. */
  async erpPoints(): Promise<ErpSexPoints> {
    const apiKey = this.settings.get().erpsexApiKey.trim()
    if (apiKey === '') throw new Error('尚未配置 API Key')
    return fetchErpSexPoints(apiKey)
  }

  /** Anlas balance of the NovelAI account. */
  async novelaiPoints(): Promise<NovelAiPoints> {
    const apiKey = this.settings.get().novelaiApiKey.trim()
    if (apiKey === '') throw new Error('尚未配置 API Key')
    return fetchNovelAiPoints(apiKey)
  }

  /** Open storage and prepare the data directories; runs once before use. */
  async start(): Promise<void> {
    await mkdir(join(this.dataDir, 'avatars'), { recursive: true })
    await mkdir(join(this.dataDir, 'images'), { recursive: true })
    await mkdir(join(this.dataDir, 'references'), { recursive: true })
    this.domain = await this.ctx.storageDomain.open(domainSpec)
    this.ctx.effect(() => () => void this.domain.close())
  }

  // ── workspace stores ─────────────────────────────────────────────────────
  // A workspace's role-play data lives in <workspace>/<subfolder>/ with
  // cards/*.json, avatars/*.png, images/*.png and an images.json record
  // index. The workspace path always arrives from the caller (the client
  // knows the current workspace; sessions record theirs on the binding).

  /** Root of a workspace's role-play data, or undefined for unusable paths. */
  wsRoot(wsPath: string | undefined): string | undefined {
    if (!wsPath || !isAbsolute(wsPath) || !existsSync(wsPath)) return undefined
    const sub = this.settings.get().workspaceSubfolder.trim() || '.dsh-roleplay'
    if (sub.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) return undefined
    return join(wsPath, sub)
  }

  private async ensureWsDirs(root: string): Promise<void> {
    await mkdir(join(root, 'cards'), { recursive: true })
    await mkdir(join(root, 'avatars'), { recursive: true })
    await mkdir(join(root, 'images'), { recursive: true })
  }

  private readWsCard(root: string, id: string): CharacterCard | undefined {
    if (!/^[A-Za-z0-9-]+$/.test(id)) return undefined
    try {
      const card = CharacterCard.parse(JSON.parse(readFileSync(join(root, 'cards', `${id}.json`), 'utf8')))
      return RoleplayService.backfillCard(card)
    } catch {
      return undefined
    }
  }

  private listWsCards(root: string): CharacterCard[] {
    let files: string[]
    try {
      files = readdirSync(join(root, 'cards'))
    } catch {
      return []
    }
    const cards: CharacterCard[] = []
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const card = this.readWsCard(root, file.slice(0, -'.json'.length))
      if (card) cards.push(card)
    }
    return cards.sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt)
  }

  private async writeWsCard(root: string, card: CharacterCard): Promise<void> {
    await this.ensureWsDirs(root)
    await writeFile(join(root, 'cards', `${card.id}.json`), JSON.stringify(card, null, 2))
  }

  /** Find a card and where it lives; global wins over the workspace on id collisions. */
  locateCard(id: string, wsPath?: string): { card: CharacterCard; scope: StoreScope; root?: string } | undefined {
    const global = this.domain.table('cards').get(id)
    if (global) return { card: RoleplayService.backfillCard(global), scope: 'global' }
    const root = this.wsRoot(wsPath)
    if (root) {
      const card = this.readWsCard(root, id)
      if (card) return { card, scope: 'workspace', root }
    }
    return undefined
  }

  /** Per-workspace serialization of images.json read-modify-write cycles. */
  private readonly wsRecordChains = new Map<string, Promise<unknown>>()

  private queueWsRecords(root: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.wsRecordChains.get(root) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    this.wsRecordChains.set(root, next)
    return next
  }

  private async readWsImageRecords(root: string): Promise<Record<string, GeneratedImage>> {
    try {
      const raw = JSON.parse(await readFile(join(root, 'images.json'), 'utf8')) as Record<string, unknown>
      const records: Record<string, GeneratedImage> = {}
      for (const [id, value] of Object.entries(raw)) {
        try {
          records[id] = GeneratedImage.parse(value)
        } catch {
          // drop malformed rows
        }
      }
      return records
    } catch {
      return {}
    }
  }

  private async writeWsImageRecords(root: string, records: Record<string, GeneratedImage>): Promise<void> {
    await writeFile(join(root, 'images.json'), JSON.stringify(records, null, 1))
  }

  /** True when the given subfolder of a workspace holds any role-play data. */
  async hasWorkspaceData(wsPath: string, sub: string): Promise<boolean> {
    if (!isAbsolute(wsPath) || sub.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) return false
    const root = join(wsPath, sub)
    if (existsSync(join(root, 'images.json'))) return true
    for (const kind of ['cards', 'avatars', 'images'] as const) {
      try {
        if ((await readdir(join(root, kind))).length > 0) return true
      } catch {
        // missing dir
      }
    }
    return false
  }

  /**
   * Move a workspace's role-play data from one subfolder to another (called
   * after the user confirms, right after the subfolder setting changed).
   * A missing source is a no-op; an existing target gets a per-file merge
   * (existing target files win).
   */
  async migrateWorkspaceFolder(wsPath: string, fromSub: string, toSub: string): Promise<{ moved: boolean }> {
    if (!isAbsolute(wsPath) || !existsSync(wsPath)) throw new Error('工作区路径无效')
    for (const sub of [fromSub, toSub]) {
      if (sub.trim() === '' || sub.split(/[\\/]/).some(part => part === '' || part === '.' || part === '..')) {
        throw new Error('子文件夹名无效')
      }
    }
    const from = join(wsPath, fromSub)
    const to = join(wsPath, toSub)
    if (from === to || !existsSync(from)) return { moved: false }
    if (!existsSync(to)) {
      await rename(from, to)
      return { moved: true }
    }
    for (const kind of ['cards', 'avatars', 'images'] as const) {
      let files: string[]
      try {
        files = await readdir(join(from, kind))
      } catch {
        continue
      }
      await mkdir(join(to, kind), { recursive: true })
      for (const file of files) {
        if (existsSync(join(to, kind, file))) continue
        await rename(join(from, kind, file), join(to, kind, file)).catch(() => {})
      }
    }
    if (existsSync(join(from, 'images.json'))) {
      const source = await this.readWsImageRecords(from)
      const target = await this.readWsImageRecords(to)
      await this.writeWsImageRecords(to, { ...source, ...target })
      await rm(join(from, 'images.json'), { force: true })
    }
    return { moved: true }
  }

  // ── cards ────────────────────────────────────────────────────────────────

  /** Global cards first (the user-facing priority order), then the workspace's. */
  listCards(wsPath?: string): (CharacterCard & { scope: StoreScope })[] {
    const global = [...this.domain.table('cards').entries()]
      .map(([, card]) => ({ ...RoleplayService.backfillCard(card), scope: 'global' as const }))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt)
    const root = this.wsRoot(wsPath)
    const workspace = root
      ? this.listWsCards(root).map(card => ({ ...card, scope: 'workspace' as const }))
      : []
    return [...global, ...workspace]
  }

  getCard(id: string, wsPath?: string): CharacterCard | undefined {
    return this.locateCard(id, wsPath)?.card
  }

  cardScope(id: string, wsPath?: string): StoreScope | undefined {
    return this.locateCard(id, wsPath)?.scope
  }

  /** Rows written before newer schema fields existed get their defaults on read. */
  private static backfillCard(card: CharacterCard): CharacterCard {
    return card.regexScripts === undefined ? { ...card, regexScripts: [] } : card
  }

  /**
   * Create or update a card. Updates stay in the store the card lives in;
   * creations go to `store` (default global; workspace requires a usable
   * `wsPath` and falls back to global without one).
   */
  async saveCard(raw: unknown, opts?: { store?: StoreScope | undefined; wsPath?: string | undefined }): Promise<CharacterCard> {
    const now = Date.now()
    const input = CharacterCard.parse({
      createdAt: now,
      updatedAt: now,
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      id: (raw as { id?: string })?.id || randomUUID(),
    })
    const located = this.locateCard(input.id, opts?.wsPath)
    const card: CharacterCard = {
      ...input,
      createdAt: located?.card.createdAt ?? now,
      updatedAt: now,
      ...(input.avatar === undefined && located?.card.avatar !== undefined ? { avatar: located.card.avatar } : {}),
    }
    const root = located?.scope === 'workspace'
      ? located.root
      : located ? undefined : (opts?.store === 'workspace' ? this.wsRoot(opts.wsPath) : undefined)
    if (root) {
      await this.writeWsCard(root, card)
    } else {
      await this.domain.table('cards').put(card.id, card)
    }
    return card
  }

  async deleteCard(id: string, wsPath?: string): Promise<boolean> {
    const located = this.locateCard(id, wsPath)
    if (!located) return false
    const { card, scope, root } = located
    if (scope === 'workspace' && root) {
      if (card.avatar) await rm(join(root, 'avatars', card.avatar), { force: true })
      await rm(join(root, 'cards', `${id}.json`), { force: true })
      return true
    }
    if (card.avatar) await rm(join(this.dataDir, 'avatars', card.avatar), { force: true })
    return this.domain.table('cards').delete(id)
  }

  /** Attach a portrait (PNG bytes) to a card, stored beside the card itself. */
  async setAvatar(cardId: string, png: Buffer, wsPath?: string): Promise<CharacterCard> {
    const located = this.locateCard(cardId, wsPath)
    if (!located) throw new Error(`unknown card ${cardId}`)
    if (!isPng(png)) throw new Error('avatar must be a PNG image')
    const file = `${cardId}.png`
    const next = { ...located.card, avatar: file, updatedAt: Date.now() }
    if (located.scope === 'workspace' && located.root) {
      await this.ensureWsDirs(located.root)
      await writeFile(join(located.root, 'avatars', file), png)
      await this.writeWsCard(located.root, next)
    } else {
      await writeFile(join(this.dataDir, 'avatars', file), png)
      await this.domain.table('cards').put(cardId, next)
    }
    return next
  }

  /** Detach a card's portrait and clear the reference. */
  async deleteAvatar(cardId: string, wsPath?: string): Promise<CharacterCard> {
    const located = this.locateCard(cardId, wsPath)
    if (!located) throw new Error(`unknown card ${cardId}`)
    const { card, scope, root } = located
    if (card.avatar) {
      const dir = scope === 'workspace' && root ? join(root, 'avatars') : join(this.dataDir, 'avatars')
      await rm(join(dir, card.avatar), { force: true })
    }
    const next = { ...card, avatar: undefined, updatedAt: Date.now() }
    if (scope === 'workspace' && root) {
      await this.writeWsCard(root, next)
    } else {
      await this.domain.table('cards').put(cardId, next)
    }
    return next
  }

  /** Use an already generated image (either store) as a card's portrait. */
  async setAvatarFromImage(cardId: string, imageId: string, wsPath?: string): Promise<CharacterCard> {
    const bytes = await this.readImageFile(imageId, wsPath)
    if (!bytes) throw new Error(`unknown image ${imageId}`)
    return this.setAvatar(cardId, bytes, wsPath)
  }

  async readAvatar(card: CharacterCard, wsRoot?: string): Promise<Buffer | undefined> {
    if (!card.avatar) return undefined
    try {
      const dir = wsRoot ? join(wsRoot, 'avatars') : join(this.dataDir, 'avatars')
      return await readFile(join(dir, card.avatar))
    } catch {
      return undefined
    }
  }

  /** Import one card from a JSON or PNG payload into the configured default store. */
  async importCard(bytes: Buffer, wsPath?: string): Promise<CharacterCard> {
    const opts = { store: this.settings.get().cardStore, wsPath }
    if (isPng(bytes)) {
      const parsed = cardFromPng(bytes)
      if (!parsed) throw new Error('该 PNG 中没有嵌入角色卡数据')
      const card = await this.saveCard(parsed, opts)
      return this.setAvatar(card.id, bytes, wsPath)
    }
    const json = JSON.parse(bytes.toString('utf8')) as unknown
    return this.saveCard(cardFromInterchange(json), opts)
  }

  /** Move a card (with its portrait) between the global and workspace stores. */
  async moveCard(id: string, to: StoreScope, wsPath?: string): Promise<CharacterCard & { scope: StoreScope }> {
    const located = this.locateCard(id, wsPath)
    if (!located) throw new Error(`unknown card ${id}`)
    if (located.scope === to) return { ...located.card, scope: to }
    const root = this.wsRoot(wsPath)
    if (to === 'workspace' && !root) throw new Error('当前没有可用的工作区')
    const avatar = await this.readAvatar(located.card, located.root)
    if (to === 'workspace' && root) {
      await this.writeWsCard(root, located.card)
      if (avatar && located.card.avatar) {
        await writeFile(join(root, 'avatars', located.card.avatar), avatar)
      }
      if (located.card.avatar) await rm(join(this.dataDir, 'avatars', located.card.avatar), { force: true })
      await this.domain.table('cards').delete(id)
    } else {
      await this.domain.table('cards').put(id, located.card)
      if (avatar && located.card.avatar) {
        await writeFile(join(this.dataDir, 'avatars', located.card.avatar), avatar)
      }
      if (located.root) {
        if (located.card.avatar) await rm(join(located.root, 'avatars', located.card.avatar), { force: true })
        await rm(join(located.root, 'cards', `${id}.json`), { force: true })
      }
    }
    return { ...located.card, scope: to }
  }

  exportCardJson(id: string, wsPath?: string): string {
    const card = this.getCard(id, wsPath)
    if (!card) throw new Error(`unknown card ${id}`)
    return JSON.stringify(cardToInterchange(card), null, 2)
  }

  async exportCardPng(id: string, wsPath?: string): Promise<Buffer> {
    const located = this.locateCard(id, wsPath)
    if (!located) throw new Error(`unknown card ${id}`)
    const portrait = (await this.readAvatar(located.card, located.root)) ?? encodeSolidPng(512, 768, [38, 41, 58])
    return cardToPng(located.card, portrait)
  }

  // ── session bindings ─────────────────────────────────────────────────────

  getBinding(sessionId: string): SessionBinding | undefined {
    return this.domain.table('sessions').get(sessionId)
  }

  async updateBinding(
    sessionId: string,
    patch: Partial<Omit<SessionBinding, 'characterId' | 'imageCount' | 'referenceMode' | 'pendingInstruction' | 'workspacePath'>> & {
      characterId?: string | null
      /** null clears the override back to the global setting. */
      imageCount?: number | null
      /** null clears the override back to the global setting. */
      referenceMode?: SessionBinding['referenceMode'] | null
      /** null clears the staged one-shot instruction. */
      pendingInstruction?: string | null
      /** null forgets the recorded workspace path. */
      workspacePath?: string | null
    },
  ): Promise<SessionBinding> {
    const existing = this.getBinding(sessionId)
    const merged: Record<string, unknown> = {
      mode: 'roleplay',
      ...existing,
      ...patch,
      sessionId,
      updatedAt: Date.now(),
    }
    // null = "remove the override": the schema keeps these keys absent.
    for (const key of ['characterId', 'imageCount', 'referenceMode', 'pendingInstruction', 'workspacePath'] as const) {
      if (merged[key] === null || merged[key] === '') delete merged[key]
    }
    const next = SessionBinding.parse(merged)
    await this.domain.table('sessions').put(sessionId, next)
    return next
  }

  // ── image generation ─────────────────────────────────────────────────────

  imageProviderStatus(): { provider: string; available: boolean } {
    const selected = this.settings.get().imageProvider
    if (selected === 'none') return { provider: 'none', available: false }
    const provider = this.providers.find(p => p.id === selected)
    return { provider: selected, available: provider?.available() ?? false }
  }

  imageUrl(id: string, wsPath?: string): string {
    const base = `/x-roleplay/files/images/${id}.png`
    return wsPath ? `${base}?ws=${encodeURIComponent(wsPath)}` : base
  }

  avatarUrl(card: CharacterCard, scope?: StoreScope, wsPath?: string): string | undefined {
    if (!card.avatar) return undefined
    const base = `/x-roleplay/files/avatars/${card.avatar}`
    return scope === 'workspace' && wsPath ? `${base}?ws=${encodeURIComponent(wsPath)}` : base
  }

  /** Read one generated image's bytes, trying the global store then the workspace. */
  async readImageFile(id: string, wsPath?: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{16,64}$/.test(id)) return undefined
    try {
      return await readFile(join(this.dataDir, 'images', `${id}.png`))
    } catch {
      const root = this.wsRoot(wsPath)
      if (!root) return undefined
      try {
        return await readFile(join(root, 'images', `${id}.png`))
      } catch {
        return undefined
      }
    }
  }

  /**
   * Serve one stored file. A workspace path serves from that workspace's
   * subfolder, falling back to the global dir so chat cards that reference a
   * since-moved image keep rendering.
   */
  async readDataFile(kind: 'avatars' | 'images', file: string, wsPath?: string): Promise<Buffer | undefined> {
    if (!/^[A-Za-z0-9._-]+\.png$/.test(file)) return undefined
    const root = this.wsRoot(wsPath)
    if (root) {
      try {
        return await readFile(join(root, kind, file))
      } catch {
        // fall through to the global dir
      }
    }
    try {
      return await readFile(join(this.dataDir, kind, file))
    } catch {
      return undefined
    }
  }

  /**
   * The reference image for one generation, resolved per caller session: the
   * session binding's mode override wins over the global setting; `custom`
   * prefers the session's own uploaded image over the global one.
   */
  async referenceImageFor(agentId?: string): Promise<Buffer | undefined> {
    const binding = agentId ? this.getBinding(agentId) : undefined
    const mode = binding?.referenceMode ?? this.settings.get().referenceMode
    if (mode === 'none') return undefined
    if (mode === 'custom') {
      if (agentId) {
        const own = await this.readSessionReferenceImage(agentId)
        if (own) return own
      }
      return this.readReferenceImage()
    }
    if (mode === 'avatar' && agentId) {
      const located = binding?.characterId ? this.locateCard(binding.characterId, binding.workspacePath) : undefined
      if (located) return this.readAvatar(located.card, located.root)
    }
    return undefined
  }

  private sessionReferencePath(sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return undefined
    return join(this.dataDir, 'references', `${sessionId}.png`)
  }

  /** Persist a session's own custom reference image (PNG bytes). */
  async setSessionReferenceImage(sessionId: string, png: Buffer): Promise<void> {
    const path = this.sessionReferencePath(sessionId)
    if (!path) throw new Error('invalid session id')
    if (!isPng(png)) throw new Error('reference image must be a PNG file')
    await writeFile(path, png)
  }

  async readSessionReferenceImage(sessionId: string): Promise<Buffer | undefined> {
    const path = this.sessionReferencePath(sessionId)
    if (!path) return undefined
    try {
      return await readFile(path)
    } catch {
      return undefined
    }
  }

  async deleteSessionReferenceImage(sessionId: string): Promise<void> {
    const path = this.sessionReferencePath(sessionId)
    if (path) await rm(path, { force: true })
  }

  hasSessionReferenceImage(sessionId: string): boolean {
    const path = this.sessionReferencePath(sessionId)
    return path !== undefined && existsSync(path)
  }

  /** Persist the custom reference image (PNG bytes) used by the 'custom' mode. */
  async setReferenceImage(png: Buffer): Promise<void> {
    if (!isPng(png)) throw new Error('reference image must be a PNG file')
    await writeFile(join(this.dataDir, 'reference.png'), png)
  }

  async readReferenceImage(): Promise<Buffer | undefined> {
    try {
      return await readFile(join(this.dataDir, 'reference.png'))
    } catch {
      return undefined
    }
  }

  /**
   * Generate `count` images for one prompt. Results are cached by content
   * hash, so replaying a logged tool call reuses the stored files.
   *
   * Ids are content hashes computed up-front, so with `wait: false` the refs
   * return immediately while generation runs in the background — poll
   * `imageStates()` until every id leaves `pending`. `wait: true` resolves
   * only after all files exist (rejecting on the first failure).
   * @param agentId - caller session id, used to resolve the avatar reference.
   */
  async generateImages(
    prompt: string,
    count: number,
    signal?: AbortSignal,
    agentId?: string,
    wait = true,
  ): Promise<GeneratedImageRef[]> {
    const config = this.settings.get()
    if (config.imageProvider === 'none') throw new Error('未启用生图后端：请在「设置 → 角色扮演」中选择并配置生图接口')
    const provider = this.providers.find(p => p.id === config.imageProvider)
    if (!provider || !provider.available()) {
      throw new Error(`生图后端 ${config.imageProvider} 未配置完整（缺少地址或密钥）`)
    }
    const { width, height } = dimensionsOf(config.imageSize)
    const fullPrompt = [config.stylePrompt.trim(), prompt.trim()].filter(Boolean).join(', ')
    const total = Math.min(6, Math.max(1, Math.floor(count)))
    const reference = await this.referenceImageFor(agentId)
    // Store target: the workspace of the calling session when the setting
    // asks for it AND the session recorded a usable workspace path.
    const wsPath = config.imageStore === 'workspace'
      ? (agentId ? this.getBinding(agentId)?.workspacePath : undefined)
      : undefined
    const root = this.wsRoot(wsPath)
    if (root) await this.ensureWsDirs(root)
    const imagesDir = root ? join(root, 'images') : join(this.dataDir, 'images')
    // The reference participates in the cache key BY CONTENT, so two sessions
    // with different avatars (or an updated upload) never share a cached file.
    const referenceKey = reference ? createHash('sha256').update(reference).digest('hex').slice(0, 12) : 'none'
    const refs: GeneratedImageRef[] = []
    const tasks: Promise<void>[] = []
    for (let index = 0; index < total; index++) {
      const id = createHash('sha256')
        .update(JSON.stringify({ p: fullPrompt, n: config.negativePrompt, w: width, h: height, provider: provider.id, index, r: referenceKey }))
        .digest('hex')
        .slice(0, 40)
      const path = join(imagesDir, `${id}.png`)
      const alreadyRunning = this.imageTaskStates.get(id)?.status === 'pending'
      if (!existsSync(path) && !alreadyRunning) {
        this.imageTaskStates.set(id, { status: 'pending' })
        const run = () => provider.generate({
          prompt: fullPrompt,
          negativePrompt: config.negativePrompt,
          width,
          height,
          aspect: aspectOf(config.imageSize),
          // Background tasks outlive the tool call, so they must not die with its signal.
          signal: wait ? signal : undefined,
          reference,
          referenceStrength: config.referenceStrength,
        })
        // The chain assignment happens synchronously here, keeping strict
        // FIFO ordering across ids and across concurrent callers.
        const settled = (this.generationChain = this.generationChain.then(run, run))
        tasks.push((async () => {
          try {
            const bytes = (await settled) as Buffer
            await writeFile(path, bytes)
            const record = GeneratedImage.parse({
              id,
              prompt: fullPrompt,
              provider: provider.id,
              width,
              height,
              createdAt: Date.now(),
            })
            if (root) {
              await this.queueWsRecords(root, async () => {
                const records = await this.readWsImageRecords(root)
                records[id] = record
                await this.writeWsImageRecords(root, records)
              })
            } else {
              await this.domain.table('images').put(id, record)
            }
            this.imageTaskStates.delete(id)
          } catch (error) {
            this.imageTaskStates.set(id, {
              status: 'failed',
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        })())
      }
      refs.push({ id, url: this.imageUrl(id, root ? wsPath : undefined), width, height })
    }
    if (wait) {
      const outcomes = await Promise.allSettled(tasks)
      const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
      if (failure) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason))
    } else {
      // Detach: outcomes land in imageTaskStates for the client to poll.
      for (const task of tasks) task.catch(() => {})
    }
    return refs
  }

  /** Poll-facing generation state per id: ready (file on disk), pending, or failed. */
  imageStates(ids: string[], wsPath?: string): Record<string, { status: 'ready' | 'pending' | 'failed'; error?: string }> {
    const root = this.wsRoot(wsPath)
    const states: Record<string, { status: 'ready' | 'pending' | 'failed'; error?: string }> = {}
    for (const id of ids) {
      if (!/^[a-f0-9]{16,64}$/.test(id)) continue
      const running = this.imageTaskStates.get(id)
      const onDisk = existsSync(join(this.dataDir, 'images', `${id}.png`))
        || (root !== undefined && existsSync(join(root, 'images', `${id}.png`)))
      if (running) {
        states[id] = running.status === 'failed' ? { status: 'failed', ...(running.error ? { error: running.error } : {}) } : { status: 'pending' }
      } else if (onDisk) {
        states[id] = { status: 'ready' }
      } else {
        states[id] = { status: 'failed', error: '图片不存在（可能已被删除或生成中断）' }
      }
    }
    return states
  }

  // ── gallery ──────────────────────────────────────────────────────────────

  /**
   * Every stored image (global plus the workspace's) with its file size,
   * starred-then-newest first, plus disk usage across both stores. Records
   * whose file disappeared are pruned on the way.
   */
  async listImages(wsPath?: string): Promise<{
    images: (GeneratedImage & { size: number; url: string; scope: StoreScope })[]
    usage: {
      usedBytes: number
      freeBytes: number
      totalBytes: number
      /** Present only when the workspace lives on a DIFFERENT partition than the global dir. */
      wsFreeBytes?: number
      wsTotalBytes?: number
    }
  }> {
    const table = this.domain.table('images')
    const images: (GeneratedImage & { size: number; url: string; scope: StoreScope })[] = []
    let usedBytes = 0
    for (const [id, record] of [...table.entries()]) {
      try {
        const info = await stat(join(this.dataDir, 'images', `${id}.png`))
        usedBytes += info.size
        images.push({ ...record, size: info.size, url: this.imageUrl(id), scope: 'global' })
      } catch {
        await table.delete(id)
      }
    }
    const root = this.wsRoot(wsPath)
    if (root) {
      const records = await this.readWsImageRecords(root)
      let pruned = false
      for (const [id, record] of Object.entries(records)) {
        try {
          const info = await stat(join(root, 'images', `${id}.png`))
          usedBytes += info.size
          images.push({ ...record, size: info.size, url: this.imageUrl(id, wsPath), scope: 'workspace' })
        } catch {
          delete records[id]
          pruned = true
        }
      }
      if (pruned) await this.queueWsRecords(root, () => this.writeWsImageRecords(root, records))
    }
    images.sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt)
    let freeBytes = 0
    let totalBytes = 0
    let wsFreeBytes: number | undefined
    let wsTotalBytes: number | undefined
    try {
      const fs = await statfs(this.dataDir)
      freeBytes = fs.bavail * fs.bsize
      totalBytes = fs.blocks * fs.bsize
      if (root && wsPath) {
        try {
          // The subfolder may not exist yet — the workspace itself does.
          const wsFs = await statfs(root).catch(() => statfs(wsPath))
          // Same-partition check: drive roots on Windows, filesystem
          // fingerprint (type/block size/block count) elsewhere.
          const same = process.platform === 'win32'
            ? parse(resolve(this.dataDir)).root.toLowerCase() === parse(resolve(wsPath)).root.toLowerCase()
            : wsFs.type === fs.type && wsFs.bsize === fs.bsize && wsFs.blocks === fs.blocks
          if (!same) {
            wsFreeBytes = wsFs.bavail * wsFs.bsize
            wsTotalBytes = wsFs.blocks * wsFs.bsize
          }
        } catch {
          // workspace disk stats unavailable: only the global line shows
        }
      }
    } catch {
      // usage stays partial on filesystems without statfs
    }
    return {
      images,
      usage: {
        usedBytes,
        freeBytes,
        totalBytes,
        ...(wsFreeBytes !== undefined && wsTotalBytes !== undefined ? { wsFreeBytes, wsTotalBytes } : {}),
      },
    }
  }

  /** Find one image's record and which store holds it. */
  private async locateImage(id: string, wsPath?: string): Promise<
    { record: GeneratedImage; scope: StoreScope; root?: string } | undefined
  > {
    const global = this.domain.table('images').get(id)
    if (global) return { record: global, scope: 'global' }
    const root = this.wsRoot(wsPath)
    if (root) {
      const record = (await this.readWsImageRecords(root))[id]
      if (record) return { record, scope: 'workspace', root }
    }
    return undefined
  }

  async setImageStarred(id: string, starred: boolean, wsPath?: string): Promise<void> {
    const located = await this.locateImage(id, wsPath)
    if (!located) throw new Error(`unknown image ${id}`)
    if (located.scope === 'workspace' && located.root) {
      const root = located.root
      await this.queueWsRecords(root, async () => {
        const records = await this.readWsImageRecords(root)
        if (records[id]) records[id] = { ...records[id], starred }
        await this.writeWsImageRecords(root, records)
      })
      return
    }
    await this.domain.table('images').put(id, { ...located.record, starred })
  }

  /** Delete images (files + records) from whichever store holds each id. */
  async deleteImages(ids: string[], wsPath?: string): Promise<number> {
    let deleted = 0
    const root = this.wsRoot(wsPath)
    for (const id of ids) {
      if (!/^[a-f0-9]{16,64}$/.test(id)) continue
      if (this.domain.table('images').get(id)) {
        await rm(join(this.dataDir, 'images', `${id}.png`), { force: true })
        if (await this.domain.table('images').delete(id)) deleted++
        continue
      }
      if (root) {
        await rm(join(root, 'images', `${id}.png`), { force: true })
        await this.queueWsRecords(root, async () => {
          const records = await this.readWsImageRecords(root)
          if (records[id]) {
            delete records[id]
            deleted++
          }
          await this.writeWsImageRecords(root, records)
        })
      }
    }
    return deleted
  }

  /** Move images between the global and workspace stores (file + record, same id). */
  async moveImages(ids: string[], to: StoreScope, wsPath?: string): Promise<number> {
    const root = this.wsRoot(wsPath)
    if (to === 'workspace' && !root) throw new Error('当前没有可用的工作区')
    let moved = 0
    for (const id of ids) {
      const located = await this.locateImage(id, wsPath)
      if (!located || located.scope === to) continue
      const sourceDir = located.scope === 'workspace' && located.root ? join(located.root, 'images') : join(this.dataDir, 'images')
      let bytes: Buffer
      try {
        bytes = await readFile(join(sourceDir, `${id}.png`))
      } catch {
        continue
      }
      if (to === 'workspace' && root) {
        await this.ensureWsDirs(root)
        await writeFile(join(root, 'images', `${id}.png`), bytes)
        await this.queueWsRecords(root, async () => {
          const records = await this.readWsImageRecords(root)
          records[id] = located.record
          await this.writeWsImageRecords(root, records)
        })
        await rm(join(this.dataDir, 'images', `${id}.png`), { force: true })
        await this.domain.table('images').delete(id)
      } else {
        await writeFile(join(this.dataDir, 'images', `${id}.png`), bytes)
        await this.domain.table('images').put(id, located.record)
        if (located.root) {
          const sourceRoot = located.root
          await rm(join(sourceRoot, 'images', `${id}.png`), { force: true })
          await this.queueWsRecords(sourceRoot, async () => {
            const records = await this.readWsImageRecords(sourceRoot)
            delete records[id]
            await this.writeWsImageRecords(sourceRoot, records)
          })
        }
      }
      moved++
    }
    return moved
  }

  /**
   * Re-run generation for stored images with their original full prompt and
   * dimensions, overwriting the same file ids so chat cards keep working.
   */
  async regenerateImages(ids: string[], signal?: AbortSignal, wsPath?: string): Promise<string[]> {
    const config = this.settings.get()
    if (config.imageProvider === 'none') throw new Error('未启用生图后端：请在「设置 → 角色扮演」中选择并配置生图接口')
    const provider = this.providers.find(p => p.id === config.imageProvider)
    if (!provider || !provider.available()) {
      throw new Error(`生图后端 ${config.imageProvider} 未配置完整（缺少地址或密钥）`)
    }
    const fallback = dimensionsOf(config.imageSize)
    // Nearest ratio-keyword for a stored width/height, for ratio-based backends.
    const aspectFor = (width: number, height: number): string => {
      const ratio = width / height
      const candidates: [string, number][] = [['1:1', 1], ['4:3', 4 / 3], ['16:9', 16 / 9], ['3:4', 3 / 4], ['9:16', 9 / 16]]
      candidates.sort((a, b) => Math.abs(a[1] - ratio) - Math.abs(b[1] - ratio))
      return candidates[0]![0]
    }
    const done: string[] = []
    for (const id of ids) {
      const located = await this.locateImage(id, wsPath)
      if (!located) continue
      const { record } = located
      const width = record.width ?? fallback.width
      const height = record.height ?? fallback.height
      const run = () => provider.generate({
        prompt: record.prompt,
        negativePrompt: config.negativePrompt,
        width,
        height,
        aspect: aspectFor(width, height),
        signal,
      })
      const bytes = (await (this.generationChain = this.generationChain.then(run, run))) as Buffer
      if (located.scope === 'workspace' && located.root) {
        const root = located.root
        await writeFile(join(root, 'images', `${id}.png`), bytes)
        await this.queueWsRecords(root, async () => {
          const records = await this.readWsImageRecords(root)
          if (records[id]) records[id] = { ...records[id], createdAt: Date.now() }
          await this.writeWsImageRecords(root, records)
        })
      } else {
        await writeFile(join(this.dataDir, 'images', `${id}.png`), bytes)
        await this.domain.table('images').put(id, { ...record, createdAt: Date.now() })
      }
      done.push(id)
    }
    return done
  }
}
