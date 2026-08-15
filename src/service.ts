/**
 * The `roleplay` service: character cards, per-session bindings, settings and
 * image generation, shared by the HTTP surface and the per-session agent
 * plugin.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { CharacterCard, GeneratedImage, SessionBinding } from './cards/types.ts'
import { cardFromInterchange, cardFromPng, cardToInterchange, cardToPng } from './cards/codec.ts'
import { encodeSolidPng, isPng } from './cards/png.ts'
import { RoleplaySettings } from './settings.ts'
import { createNovelAiProvider } from './imagegen/novelai.ts'
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

  /** Open storage and prepare the data directories; runs once before use. */
  async start(): Promise<void> {
    await mkdir(join(this.dataDir, 'avatars'), { recursive: true })
    await mkdir(join(this.dataDir, 'images'), { recursive: true })
    await mkdir(join(this.dataDir, 'references'), { recursive: true })
    this.domain = await this.ctx.storageDomain.open(domainSpec)
    this.ctx.effect(() => () => void this.domain.close())
  }

  // ── cards ────────────────────────────────────────────────────────────────

  listCards(): CharacterCard[] {
    return [...this.domain.table('cards').entries()]
      .map(([, card]) => RoleplayService.backfillCard(card))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.createdAt - a.createdAt)
  }

  getCard(id: string): CharacterCard | undefined {
    const card = this.domain.table('cards').get(id)
    return card ? RoleplayService.backfillCard(card) : undefined
  }

  /** Rows written before newer schema fields existed get their defaults on read. */
  private static backfillCard(card: CharacterCard): CharacterCard {
    return card.regexScripts === undefined ? { ...card, regexScripts: [] } : card
  }

  async saveCard(raw: unknown): Promise<CharacterCard> {
    const now = Date.now()
    const input = CharacterCard.parse({
      createdAt: now,
      updatedAt: now,
      ...(typeof raw === 'object' && raw !== null ? raw : {}),
      id: (raw as { id?: string })?.id || randomUUID(),
    })
    const existing = this.getCard(input.id)
    const card: CharacterCard = {
      ...input,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.avatar === undefined && existing?.avatar !== undefined ? { avatar: existing.avatar } : {}),
    }
    await this.domain.table('cards').put(card.id, card)
    return card
  }

  async deleteCard(id: string): Promise<boolean> {
    const card = this.getCard(id)
    if (card?.avatar) await rm(join(this.dataDir, 'avatars', card.avatar), { force: true })
    return this.domain.table('cards').delete(id)
  }

  /** Attach a portrait (PNG bytes) to a card. */
  async setAvatar(cardId: string, png: Buffer): Promise<CharacterCard> {
    const card = this.getCard(cardId)
    if (!card) throw new Error(`unknown card ${cardId}`)
    if (!isPng(png)) throw new Error('avatar must be a PNG image')
    const file = `${cardId}.png`
    await writeFile(join(this.dataDir, 'avatars', file), png)
    const next = { ...card, avatar: file, updatedAt: Date.now() }
    await this.domain.table('cards').put(cardId, next)
    return next
  }

  /** Detach a card's portrait and clear the reference. */
  async deleteAvatar(cardId: string): Promise<CharacterCard> {
    const card = this.getCard(cardId)
    if (!card) throw new Error(`unknown card ${cardId}`)
    if (card.avatar) await rm(join(this.dataDir, 'avatars', card.avatar), { force: true })
    const next = { ...card, avatar: undefined, updatedAt: Date.now() }
    await this.domain.table('cards').put(cardId, next)
    return next
  }

  /** Use an already generated image as a card's portrait. */
  async setAvatarFromImage(cardId: string, imageId: string): Promise<CharacterCard> {
    const bytes = await this.readImageFile(imageId)
    if (!bytes) throw new Error(`unknown image ${imageId}`)
    return this.setAvatar(cardId, bytes)
  }

  async readAvatar(card: CharacterCard): Promise<Buffer | undefined> {
    if (!card.avatar) return undefined
    try {
      return await readFile(join(this.dataDir, 'avatars', card.avatar))
    } catch {
      return undefined
    }
  }

  /** Import one card from a JSON or PNG payload. */
  async importCard(bytes: Buffer): Promise<CharacterCard> {
    if (isPng(bytes)) {
      const parsed = cardFromPng(bytes)
      if (!parsed) throw new Error('该 PNG 中没有嵌入角色卡数据')
      const card = await this.saveCard(parsed)
      return this.setAvatar(card.id, bytes)
    }
    const json = JSON.parse(bytes.toString('utf8')) as unknown
    return this.saveCard(cardFromInterchange(json))
  }

  exportCardJson(id: string): string {
    const card = this.getCard(id)
    if (!card) throw new Error(`unknown card ${id}`)
    return JSON.stringify(cardToInterchange(card), null, 2)
  }

  async exportCardPng(id: string): Promise<Buffer> {
    const card = this.getCard(id)
    if (!card) throw new Error(`unknown card ${id}`)
    const portrait = (await this.readAvatar(card)) ?? encodeSolidPng(512, 768, [38, 41, 58])
    return cardToPng(card, portrait)
  }

  // ── session bindings ─────────────────────────────────────────────────────

  getBinding(sessionId: string): SessionBinding | undefined {
    return this.domain.table('sessions').get(sessionId)
  }

  async updateBinding(
    sessionId: string,
    patch: Partial<Omit<SessionBinding, 'characterId' | 'imageCount' | 'referenceMode' | 'pendingInstruction'>> & {
      characterId?: string | null
      /** null clears the override back to the global setting. */
      imageCount?: number | null
      /** null clears the override back to the global setting. */
      referenceMode?: SessionBinding['referenceMode'] | null
      /** null clears the staged one-shot instruction. */
      pendingInstruction?: string | null
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
    for (const key of ['characterId', 'imageCount', 'referenceMode', 'pendingInstruction'] as const) {
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

  imageUrl(id: string): string {
    return `/x-roleplay/files/images/${id}.png`
  }

  avatarUrl(card: CharacterCard): string | undefined {
    return card.avatar ? `/x-roleplay/files/avatars/${card.avatar}` : undefined
  }

  async readImageFile(id: string): Promise<Buffer | undefined> {
    if (!/^[a-f0-9]{16,64}$/.test(id)) return undefined
    try {
      return await readFile(join(this.dataDir, 'images', `${id}.png`))
    } catch {
      return undefined
    }
  }

  async readDataFile(kind: 'avatars' | 'images', file: string): Promise<Buffer | undefined> {
    if (!/^[A-Za-z0-9._-]+\.png$/.test(file)) return undefined
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
      const card = binding?.characterId ? this.getCard(binding.characterId) : undefined
      if (card) return this.readAvatar(card)
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
      const path = join(this.dataDir, 'images', `${id}.png`)
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
            await this.domain.table('images').put(id, GeneratedImage.parse({
              id,
              prompt: fullPrompt,
              provider: provider.id,
              width,
              height,
              createdAt: Date.now(),
            }))
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
      refs.push({ id, url: this.imageUrl(id), width, height })
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
  imageStates(ids: string[]): Record<string, { status: 'ready' | 'pending' | 'failed'; error?: string }> {
    const states: Record<string, { status: 'ready' | 'pending' | 'failed'; error?: string }> = {}
    for (const id of ids) {
      if (!/^[a-f0-9]{16,64}$/.test(id)) continue
      const running = this.imageTaskStates.get(id)
      if (running) {
        states[id] = running.status === 'failed' ? { status: 'failed', ...(running.error ? { error: running.error } : {}) } : { status: 'pending' }
      } else if (existsSync(join(this.dataDir, 'images', `${id}.png`))) {
        states[id] = { status: 'ready' }
      } else {
        states[id] = { status: 'failed', error: '图片不存在（可能已被删除或生成中断）' }
      }
    }
    return states
  }

  // ── gallery ──────────────────────────────────────────────────────────────

  /**
   * Every stored image with its file size, newest first, plus the data-dir
   * disk usage. Records whose file disappeared are pruned on the way.
   */
  async listImages(): Promise<{
    images: (GeneratedImage & { size: number; url: string })[]
    usage: { usedBytes: number; freeBytes: number; totalBytes: number }
  }> {
    const table = this.domain.table('images')
    const images: (GeneratedImage & { size: number; url: string })[] = []
    let usedBytes = 0
    for (const [id, record] of [...table.entries()]) {
      try {
        const info = await stat(join(this.dataDir, 'images', `${id}.png`))
        usedBytes += info.size
        images.push({ ...record, size: info.size, url: this.imageUrl(id) })
      } catch {
        await table.delete(id)
      }
    }
    images.sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt)
    let freeBytes = 0
    let totalBytes = 0
    try {
      const fs = await statfs(this.dataDir)
      freeBytes = fs.bavail * fs.bsize
      totalBytes = fs.blocks * fs.bsize
    } catch {
      // usage stays partial on filesystems without statfs
    }
    return { images, usage: { usedBytes, freeBytes, totalBytes } }
  }

  async setImageStarred(id: string, starred: boolean): Promise<void> {
    const record = this.domain.table('images').get(id)
    if (!record) throw new Error(`unknown image ${id}`)
    await this.domain.table('images').put(id, { ...record, starred })
  }

  /** Delete images (files + records); returns how many files were removed. */
  async deleteImages(ids: string[]): Promise<number> {
    let deleted = 0
    for (const id of ids) {
      if (!/^[a-f0-9]{16,64}$/.test(id)) continue
      await rm(join(this.dataDir, 'images', `${id}.png`), { force: true })
      if (await this.domain.table('images').delete(id)) deleted++
    }
    return deleted
  }

  /**
   * Re-run generation for stored images with their original full prompt and
   * dimensions, overwriting the same file ids so chat cards keep working.
   */
  async regenerateImages(ids: string[], signal?: AbortSignal): Promise<string[]> {
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
      const record = this.domain.table('images').get(id)
      if (!record) continue
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
      await writeFile(join(this.dataDir, 'images', `${id}.png`), bytes)
      await this.domain.table('images').put(id, { ...record, createdAt: Date.now() })
      done.push(id)
    }
    return done
  }
}
