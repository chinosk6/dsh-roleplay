/** The「角色扮演」settings page: user identity, image backend, storage, gallery and card library + sub-pages. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, formatBytes, stampedUrl, type CardSummary, type ErpPoints, type GalleryUsage, type RoleplaySettingsValue, type StoreScope } from './api.ts'
import { CardEditor } from './card-editor.tsx'
import { ImageGalleryPage } from './gallery.tsx'
import { recentWorkspace, subscribeWorkspaces, type WorkspaceInfo } from './runtime.ts'
import { useT, tf } from './i18n.ts'

type Draft = RoleplaySettingsValue

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="rp-field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export function RoleplaySettingsSection(): ReactNode {
  const t = useT()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [providerStatus, setProviderStatus] = useState<{ provider: string; available: boolean } | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  /** Card id being edited; set = the card-editor sub-page replaces the list. */
  const [editing, setEditing] = useState<string | null>(null)
  /** Whether the image-gallery sub-page replaces the section body. */
  const [gallery, setGallery] = useState(false)
  const saveTimer = useRef<number | undefined>(undefined)
  /** The "current" workspace (most recently active) — the workspace-store target. */
  const ws = useSyncExternalStore(subscribeWorkspaces, recentWorkspace)

  useEffect(() => {
    api.settings()
      .then(result => {
        setDraft(result.value)
        setProviderStatus(result.imageProvider)
      })
      .catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [])

  const patch = useCallback((partial: Partial<Draft>) => {
    setDraft(current => (current ? { ...current, ...partial } : current))
    setMessage('')
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void api.updateSettings(partial)
        .then(() => {
          setMessage(t('rp.settings.saved'))
          return api.settings().then(result => setProviderStatus(result.imageProvider))
        })
        .catch(err => setError(String(err instanceof Error ? err.message : err)))
    }, 500)
  }, [t])

  // ── sub-pages ──
  if (editing) {
    return <CardEditor cardId={editing} onClose={() => setEditing(null)} ws={ws?.path} />
  }
  if (gallery) {
    return <ImageGalleryPage onClose={() => setGallery(false)} ws={ws?.path} />
  }

  if (error && !draft) return <div className="rp-settings"><span className="rp-error">{error}</span></div>
  if (!draft) return <div className="rp-settings"><span className="rp-note">{t('rp.settings.loading')}</span></div>

  const text = (key: keyof Draft, label: string, props?: { placeholder?: string; secret?: boolean }) => (
    <Field label={label}>
      <input
        type={props?.secret ? 'password' : 'text'}
        placeholder={props?.placeholder}
        value={String(draft[key] ?? '')}
        onChange={event => patch({ [key]: event.target.value } as Partial<Draft>)}
      />
    </Field>
  )

  const providerLabel = providerStatus
    ? providerStatus.available ? t('rp.image.ready') : providerStatus.provider === 'none' ? t('rp.image.off') : t('rp.image.incomplete')
    : ''

  return (
    <div className="rp-settings">
      <div>
        <h3>{t('rp.settings.title')}</h3>
        <span className="rp-note">
          {t('rp.settings.note')}{message ? ` · ${message}` : ''}
        </span>
        {error ? <div className="rp-error">{error}</div> : null}
      </div>

      <div>
        <h4>{t('rp.player.heading')}</h4>
        <div className="rp-inline">
          {text('userName', t('rp.player.name'))}
        </div>
        <Field label={t('rp.player.persona')}>
          <textarea value={draft.userPersona} onChange={event => patch({ userPersona: event.target.value })} />
        </Field>
      </div>

      <div>
        <h4>{t('rp.image.heading')}{providerLabel}</h4>
        <Field label={t('rp.image.provider')}>
          <select value={draft.imageProvider} onChange={event => patch({ imageProvider: event.target.value as Draft['imageProvider'] })}>
            <option value="none">{t('rp.image.none')}</option>
            <option value="novelai">{t('rp.image.novelai')}</option>
            <option value="erpsex">{t('rp.image.erpsex')}</option>
            <option value="sdwebui">{t('rp.image.sdwebui')}</option>
            <option value="url">{t('rp.image.url')}</option>
          </select>
        </Field>
        {draft.imageProvider === 'erpsex' ? (
          <ErpSexConfig
            apiKey={draft.erpsexApiKey}
            model={draft.erpsexModel}
            onKeyChange={value => patch({ erpsexApiKey: value })}
            onModelChange={value => patch({ erpsexModel: value })}
          />
        ) : null}
        {draft.imageProvider === 'novelai' ? (
          <div>
            {text('novelaiApiUrl', t('rp.image.apiUrl'))}
            {text('novelaiApiKey', t('rp.image.apiKey'), { secret: true })}
            {text('novelaiModel', t('rp.image.model'))}
          </div>
        ) : null}
        {draft.imageProvider === 'sdwebui' ? (
          <div>
            {text('sdwebuiBaseUrl', t('rp.image.baseUrl'), { placeholder: 'http://127.0.0.1:7860' })}
            <div className="rp-inline">
              <Field label={t('rp.image.steps')}>
                <input type="number" value={draft.sdwebuiSteps} onChange={event => patch({ sdwebuiSteps: Number(event.target.value) || 28 })} />
              </Field>
              <Field label={t('rp.image.cfg')}>
                <input type="number" value={draft.sdwebuiCfgScale} onChange={event => patch({ sdwebuiCfgScale: Number(event.target.value) || 7 })} />
              </Field>
              {text('sdwebuiSampler', t('rp.image.sampler'))}
            </div>
          </div>
        ) : null}
        {draft.imageProvider === 'url' ? (
          <div>
            {text('urlTemplate', t('rp.image.template'), { placeholder: 'https://example.com/generate?tag={prompt}' })}
          </div>
        ) : null}
        <Field label={t('rp.image.style')}>
          <textarea value={draft.stylePrompt} onChange={event => patch({ stylePrompt: event.target.value })} />
        </Field>
        <Field label={t('rp.image.negative')}>
          <textarea value={draft.negativePrompt} onChange={event => patch({ negativePrompt: event.target.value })} />
        </Field>
        <div className="rp-inline">
          <Field label={t('rp.image.size')}>
            {/* ratio34/ratio43 are legacy stored values folded into the primary five. */}
            <select
              value={draft.imageSize === 'ratio34' ? 'portrait' : draft.imageSize === 'ratio43' ? 'landscape' : draft.imageSize}
              onChange={event => patch({ imageSize: event.target.value as Draft['imageSize'] })}
            >
              <option value="portrait">{t('rp.image.size.portrait')}</option>
              <option value="ratio916">{t('rp.image.size.ratio916')}</option>
              <option value="landscape">{t('rp.image.size.landscape')}</option>
              <option value="ratio169">{t('rp.image.size.ratio169')}</option>
              <option value="square">{t('rp.image.size.square')}</option>
            </select>
          </Field>
          <Field label={t('rp.image.count')}>
            <input
              type="number" min={1} max={6} value={draft.imageCount}
              onChange={event => patch({ imageCount: Math.min(6, Math.max(1, Number(event.target.value) || 1)) })}
            />
          </Field>
          <Field label={t('rp.image.aggressiveness')}>
            <select value={draft.imageAggressiveness} onChange={event => patch({ imageAggressiveness: event.target.value as Draft['imageAggressiveness'] })}>
              <option value="conservative">{t('rp.image.agg.conservative')}</option>
              <option value="active">{t('rp.image.agg.active')}</option>
              <option value="force">{t('rp.image.agg.force')}</option>
            </select>
          </Field>
        </div>
        <Field label={t('rp.image.auto')}>
          <select value={draft.autoImage ? 'on' : 'off'} onChange={event => patch({ autoImage: event.target.value === 'on' })}>
            <option value="off">{t('rp.image.auto.off')}</option>
            <option value="on">{t('rp.image.auto.on')}</option>
          </select>
        </Field>
        <Field label={t('rp.image.referenceMode')}>
          <select value={draft.referenceMode} onChange={event => patch({ referenceMode: event.target.value as Draft['referenceMode'] })}>
            <option value="none">{t('rp.image.ref.none')}</option>
            <option value="avatar">{t('rp.image.ref.avatar')}</option>
            <option value="custom">{t('rp.image.ref.custom')}</option>
          </select>
        </Field>
        {draft.referenceMode !== 'none' ? (
          <div className="rp-inline">
            <Field label={t('rp.image.referenceStrength')}>
              <input
                type="number" min={0} max={1} step={0.05} value={draft.referenceStrength}
                onChange={event => patch({ referenceStrength: Math.min(1, Math.max(0, Number(event.target.value) || 0)) })}
              />
            </Field>
          </div>
        ) : null}
        {draft.referenceMode === 'custom' ? <ReferenceUploader /> : null}
      </div>

      <div>
        <h4>{t('rp.choice.heading')}</h4>
        <div className="rp-inline">
          <Field label={t('rp.choice.mode')}>
            <select value={draft.choiceMode ? 'on' : 'off'} onChange={event => patch({ choiceMode: event.target.value === 'on' })}>
              <option value="off">{t('rp.choice.off')}</option>
              <option value="on">{t('rp.choice.on')}</option>
            </select>
          </Field>
          <Field label={t('rp.choice.count')}>
            <input
              type="number" min={2} max={8} value={draft.choiceCount}
              onChange={event => patch({ choiceCount: Math.min(8, Math.max(2, Number(event.target.value) || 2)) })}
            />
          </Field>
        </div>
      </div>

      <StorageBlock draft={draft} patch={patch} ws={ws} />

      <GalleryEntry onOpen={() => setGallery(true)} ws={ws?.path} />

      <CardManager onEdit={setEditing} ws={ws} />
    </div>
  )
}

/**
 * Storage placement: which store new images/cards land in, the current
 * workspace, and the per-workspace data subfolder. Changing the subfolder
 * offers to move the current workspace's existing data along.
 */
function StorageBlock({ draft, patch, ws }: {
  draft: Draft
  patch: (partial: Partial<Draft>) => void
  ws: WorkspaceInfo | undefined
}): ReactNode {
  const t = useT()
  const [folder, setFolder] = useState(draft.workspaceSubfolder)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => setFolder(draft.workspaceSubfolder), [draft.workspaceSubfolder])

  const applyFolder = useCallback(async () => {
    const next = folder.trim()
    const prev = draft.workspaceSubfolder
    if (next === prev) return
    if (next === '' || /[\\/]/.test(next) || next === '.' || next === '..') {
      setNote(t('rp.storage.folderInvalid'))
      setFolder(prev)
      return
    }
    setBusy(true)
    setNote('')
    try {
      // Saved directly (not via the debounced patch): a migration right after
      // must already see the new subfolder setting host-side.
      await api.updateSettings({ workspaceSubfolder: next })
      patch({ workspaceSubfolder: next })
      if (ws) {
        const probe = await api.probeWorkspaceFolder(ws.path, prev).catch(() => ({ exists: false }))
        if (probe.exists && window.confirm(tf('rp.storage.migrateConfirm', { from: prev, to: next }))) {
          await api.migrateWorkspaceFolder(ws.path, prev, next)
          setNote(t('rp.storage.migrated'))
        }
      }
    } catch (err) {
      setNote(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [folder, draft.workspaceSubfolder, ws, patch, t])

  return (
    <div>
      <h4>{t('rp.storage.heading')}</h4>
      <div className="rp-field">
        <label>{t('rp.storage.currentWs')}</label>
        <span className="rp-note">
          {ws ? `${ws.title} · ${ws.path}` : t('rp.storage.noWs')}
        </span>
      </div>
      <div className="rp-inline">
        <Field label={t('rp.storage.imageStore')}>
          <select value={draft.imageStore} onChange={event => patch({ imageStore: event.target.value as StoreScope })}>
            <option value="workspace">{t('rp.storage.workspace')}</option>
            <option value="global">{t('rp.storage.global')}</option>
          </select>
        </Field>
        <Field label={t('rp.storage.cardStore')}>
          <select value={draft.cardStore} onChange={event => patch({ cardStore: event.target.value as StoreScope })}>
            <option value="workspace">{t('rp.storage.workspace')}</option>
            <option value="global">{t('rp.storage.global')}</option>
          </select>
        </Field>
        <Field label={t('rp.storage.subfolder')}>
          <div className="rp-keyrow">
            <input
              value={folder}
              disabled={busy}
              onChange={event => setFolder(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') void applyFolder() }}
            />
            <button className="rp-btn" disabled={busy || folder.trim() === draft.workspaceSubfolder} onClick={() => void applyFolder()}>
              {t('rp.storage.apply')}
            </button>
          </div>
        </Field>
      </div>
      <span className="rp-note">
        {ws ? `${t('rp.storage.pathHint')}：${ws.path}${ws.path.includes('\\') ? '\\' : '/'}${draft.workspaceSubfolder}` : t('rp.storage.hint')}
        {note ? ` · ${note}` : ''}
      </span>
    </div>
  )
}

/**
 * Hosted-wrapper backend config: no endpoint field (the site is fixed) — an
 * "open website" button instead, plus the API key with the account's points
 * balance and a manual refresh on the same row.
 */
function ErpSexConfig({ apiKey, model, onKeyChange, onModelChange }: {
  apiKey: string
  model: string
  onKeyChange: (value: string) => void
  onModelChange: (value: string) => void
}): ReactNode {
  const t = useT()
  const [points, setPoints] = useState<ErpPoints | null>(null)
  const [pointsError, setPointsError] = useState('')
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(() => {
    setLoading(true)
    setPointsError('')
    api.erpPoints()
      .then(setPoints)
      .catch(err => {
        setPoints(null)
        setPointsError(String(err instanceof Error ? err.message : err))
      })
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    if (apiKey.trim() !== '') refresh()
    // 初次挂载按已保存的 key 拉一次；输入过程中不自动刷。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh])

  return (
    <div>
      <div className="rp-field">
        <label>{t('rp.image.erpsex.site')}</label>
        <div className="rp-actions">
          <a className="rp-btn" style={{ textDecoration: 'none' }} href="https://ai.erp.sex" target="_blank" rel="noreferrer noopener">
            {t('rp.image.erpsex.open')}
          </a>
          <span className="rp-note">{t('rp.image.erpsex.keyHint')}</span>
        </div>
      </div>
      <div className="rp-field">
        <label>{t('rp.image.apiKey')}</label>
        <div className="rp-keyrow">
          <input
            type="password"
            placeholder="pst-…"
            value={apiKey}
            onChange={event => onKeyChange(event.target.value)}
          />
          <span className="rp-points" title={points ? `${t('rp.image.erpsex.frozen')}: ${points.frozenPoints}` : undefined}>
            {loading
              ? t('rp.image.erpsex.loading')
              : points
                ? tf('rp.image.erpsex.points', { points: points.points })
                : pointsError
                  ? t('rp.image.erpsex.pointsError')
                  : '—'}
          </span>
          <button className="rp-btn" disabled={loading || apiKey.trim() === ''} title={t('rp.image.erpsex.refresh')} onClick={refresh}>
            ⟳
          </button>
        </div>
        {pointsError ? <span className="rp-error">{pointsError}</span> : null}
      </div>
      <div className="rp-field">
        <label>{t('rp.image.model')}</label>
        <input
          type="text"
          placeholder="nai-diffusion-4-5-full"
          value={model}
          onChange={event => onModelChange(event.target.value)}
        />
      </div>
    </div>
  )
}

/** Gallery entry row: usage summary outside, the full page one click away. */
function GalleryEntry({ onOpen, ws }: { onOpen: () => void; ws?: string | undefined }): ReactNode {
  const t = useT()
  const [usage, setUsage] = useState<GalleryUsage | null>(null)
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    api.images(ws)
      .then(result => {
        setUsage(result.usage)
        setCount(result.images.length)
      })
      .catch(() => {})
  }, [ws])
  return (
    <div>
      <h4>{t('rp.gallery.title')}</h4>
      <div className="rp-cardrow">
        <div className="rp-grow">
          <div className="rp-name">{t('rp.gallery.title')}{count !== null ? ` · ${count}` : ''}</div>
          <div className="rp-tags">
            {usage
              ? usage.wsFreeBytes !== undefined
                ? `${tf('rp.gallery.used', { used: formatBytes(usage.usedBytes) })} · ${tf('rp.gallery.freeGlobal', { free: formatBytes(usage.freeBytes) })} · ${tf('rp.gallery.freeWs', { free: formatBytes(usage.wsFreeBytes) })}`
                : `${tf('rp.gallery.used', { used: formatBytes(usage.usedBytes) })} · ${tf('rp.gallery.free', { free: formatBytes(usage.freeBytes) })}`
              : t('rp.gallery.loading')}
          </div>
        </div>
        <div className="rp-actions">
          <button className="rp-btn" onClick={onOpen}>{t('rp.gallery.open')}</button>
        </div>
      </div>
    </div>
  )
}

function CardManager({ onEdit, ws }: { onEdit: (cardId: string) => void; ws: WorkspaceInfo | undefined }): ReactNode {
  const t = useT()
  const [cards, setCards] = useState<CardSummary[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const wsPath = ws?.path

  const reload = useCallback(() => {
    api.cards(wsPath).then(result => setCards(result.cards)).catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [wsPath])
  useEffect(reload, [reload])

  const importFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusy(true)
    setError('')
    try {
      for (const file of Array.from(files)) {
        await api.importCard(await file.arrayBuffer(), wsPath)
      }
      reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [reload, wsPath])

  const move = useCallback((card: CardSummary) => {
    void api.moveCard(card.id, card.scope === 'global' ? 'workspace' : 'global', wsPath)
      .then(reload)
      .catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [reload, wsPath])

  return (
    <div>
      <h4>{t('rp.cards.heading')}</h4>
      <div className="rp-actions" style={{ margin: '8px 0' }}>
        <button className="rp-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          {t('rp.cards.import')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".png,.json,application/json,image/png"
          multiple
          style={{ display: 'none' }}
          onChange={event => void importFiles(event.target.files)}
        />
        <span className="rp-note">{t('rp.cards.importHint')}</span>
      </div>
      {error ? <div className="rp-error">{error}</div> : null}
      {cards === null ? (
        <span className="rp-note">{t('rp.settings.loading')}</span>
      ) : cards.length === 0 ? (
        <span className="rp-note">{t('rp.cards.empty')}</span>
      ) : (
        <div>
          {cards.map(card => (
            <div key={`${card.scope}-${card.id}`} className="rp-cardrow">
              {card.avatarUrl
                ? <img className="rp-avatar" src={stampedUrl(card.avatarUrl, card.updatedAt)} alt={card.name} />
                : <div className="rp-avatar-fallback">{card.name.slice(0, 1)}</div>}
              <div className="rp-grow">
                <div className="rp-name">
                  <button
                    className="rp-star"
                    title={card.favorite ? t('rp.cards.unfavorite') : t('rp.cards.favorite')}
                    onClick={() => void api.updateCard(card.id, { favorite: !card.favorite }, wsPath).then(reload).catch(() => {})}
                  >
                    {card.favorite ? '★' : '☆'}
                  </button>
                  <span className={`rp-scope-tag rp-scope-${card.scope}`}>
                    {card.scope === 'global' ? t('rp.scope.global') : t('rp.scope.workspace')}
                  </span>
                  {card.name}
                </div>
                <div className="rp-tags">
                  {[card.creatorNotes || card.description, `${card.bookEntries}${t('rp.cards.lore')}`].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="rp-actions">
                <button className="rp-btn rp-btn-primary" onClick={() => onEdit(card.id)}>{t('rp.cards.edit')}</button>
                <button
                  className={`rp-btn ${card.scope === 'global' ? 'rp-btn-green' : 'rp-btn-blue'}`}
                  disabled={card.scope === 'global' && !ws}
                  title={card.scope === 'global' ? t('rp.cards.toWorkspace') : t('rp.cards.toGlobal')}
                  onClick={() => move(card)}
                >
                  {card.scope === 'global' ? t('rp.cards.toWorkspace') : t('rp.cards.toGlobal')}
                </button>
                <a className="rp-btn" style={{ textDecoration: 'none' }} href={api.exportPngUrl(card.id, wsPath)} download>PNG</a>
                <a className="rp-btn" style={{ textDecoration: 'none' }} href={api.exportJsonUrl(card.id, wsPath)} download>JSON</a>
                <button
                  className="rp-btn rp-btn-danger"
                  onClick={() => {
                    if (window.confirm(tf('rp.cards.deleteConfirm', { name: card.name }))) {
                      void api.deleteCard(card.id, wsPath).then(reload).catch(err => setError(String(err)))
                    }
                  }}
                >
                  {t('rp.cards.delete')}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ReferenceUploader(): ReactNode {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stamp, setStamp] = useState(0)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const upload = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    setError('')
    try {
      await api.uploadReference(await file.arrayBuffer())
      setStamp(Date.now())
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [])
  return (
    <div className="rp-actions" style={{ marginTop: 8 }}>
      <button className="rp-btn" disabled={busy} onClick={() => fileRef.current?.click()}>{t('rp.image.ref.upload')}</button>
      <input ref={fileRef} type="file" accept="image/png" style={{ display: 'none' }} onChange={event => void upload(event.target.files)} />
      <img className="rp-ref-preview" src={`${api.referenceUrl()}?t=${stamp}`} alt="" onError={event => { (event.target as HTMLImageElement).style.display = 'none' }} />
      {error ? <span className="rp-error">{error}</span> : null}
    </div>
  )
}
