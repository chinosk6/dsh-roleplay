/**
 * The character-card editor. One reusable surface for two entry points:
 *  - the「角色扮演」settings section (sub-page reached from the card library)
 *  - the save_character_card tool view (interactive result card in forge chats)
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type CharacterCardDetail, type LoreEntryValue } from './api.ts'
import { useT, tf } from './i18n.ts'

const LORE_POSITIONS = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'at_depth'] as const

/** String-typed card fields rendered as text areas. */
type TextKey = 'name' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'exampleDialogs' | 'creatorNotes'

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="rp-field">
      <label>{label}</label>
      {children}
    </div>
  )
}

export function CardEditor({ cardId, onClose, onDeleted, onSaved }: {
  cardId: string
  /** Rendered when the editor lives inside the settings section (back button). */
  onClose?: () => void
  onDeleted?: () => void
  onSaved?: () => void
}): ReactNode {
  const t = useT()
  const [card, setCard] = useState<CharacterCardDetail['card'] | null>(null)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const reload = useCallback(() => {
    setNotice('')
    api.getCard(cardId)
      .then(result => {
        setCard(result.card)
        setAvatarUrl(result.avatarUrl)
      })
      .catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [cardId])
  useEffect(reload, [reload])

  const patch = useCallback((partial: Record<string, unknown>) => {
    setCard(current => (current ? { ...current, ...partial } : current))
    setNotice('')
  }, [])

  const save = useCallback(async () => {
    if (!card) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await api.updateCard(cardId, card)
      setNotice(t('rp.editor.saved'))
      onSaved?.()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [card, cardId, t, onSaved])

  const uploadAvatar = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const result = await api.updateCardAvatar(cardId, await file.arrayBuffer())
      setAvatarUrl(result.avatarUrl)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [cardId])

  const removeAvatar = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await api.deleteCardAvatar(cardId)
      setAvatarUrl(null)
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [cardId])

  const removeCard = useCallback(async () => {
    if (!card || !window.confirm(tf('rp.cards.deleteConfirm', { name: card.name }))) return
    setBusy(true)
    try {
      await api.deleteCard(cardId)
      onDeleted?.()
      onClose?.()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
      setBusy(false)
    }
  }, [card, cardId, t, onDeleted, onClose])

  if (error && !card) {
    return (
      <div className="rp-settings">
        <div className="rp-error">{error}</div>
        {onClose ? <button className="rp-btn" onClick={onClose}>{t('rp.editor.back')}</button> : null}
      </div>
    )
  }
  if (!card) return <div className="rp-settings"><span className="rp-note">{t('rp.settings.loading')}</span></div>

  const field = (key: TextKey, label: string, rows = 2) => {
    const value = card[key]
    if (typeof value !== 'string') return null
    return (
      <Field label={label}>
        <textarea rows={rows} value={value} onChange={event => patch({ [key]: event.target.value })} />
      </Field>
    )
  }

  return (
    <div className="rp-settings rp-editor">
      <div className="rp-editor-head">
        {onClose ? <button className="rp-btn" onClick={onClose}>{t('rp.editor.back')}</button> : null}
        <span className="rp-editor-title">{t('rp.editor.title')}</span>
        <span className="rp-spacer" />
        <button className="rp-btn rp-btn-primary" disabled={busy} onClick={() => void save()}>{t('rp.editor.save')}</button>
        {notice ? <span className="rp-note">{notice}</span> : null}
        {error ? <span className="rp-error">{error}</span> : null}
      </div>

      <div className="rp-editor-avatar-row">
        {avatarUrl
          ? <img className="rp-editor-avatar" src={avatarUrl} alt={card.name} />
          : <div className="rp-editor-avatar rp-avatar-fallback">{card.name.slice(0, 1) || '?'}</div>}
        <div className="rp-actions">
          <button className="rp-btn" disabled={busy} onClick={() => fileRef.current?.click()}>{t('rp.editor.avatar.upload')}</button>
          {avatarUrl ? <button className="rp-btn" disabled={busy} onClick={() => void removeAvatar()}>{t('rp.editor.avatar.remove')}</button> : null}
          <input ref={fileRef} type="file" accept="image/png" style={{ display: 'none' }} onChange={event => void uploadAvatar(event.target.files)} />
        </div>
      </div>

      <h4>{t('rp.editor.basic')}</h4>
      <div className="rp-inline">
        <Field label={t('rp.editor.name')}>
          <input value={card.name} onChange={event => patch({ name: event.target.value })} />
        </Field>
        <Field label={t('rp.editor.tags')}>
          <input value={card.tags.join(', ')} onChange={event => patch({ tags: event.target.value.split(/[,，]/).map(part => part.trim()).filter(Boolean) })} />
        </Field>
      </div>
      {field('description', t('rp.editor.description'), 2)}
      {field('personality', t('rp.editor.personality'), 10)}
      {field('scenario', t('rp.editor.scenario'), 3)}
      {field('firstMessage', t('rp.editor.firstMessage'), 6)}
      {field('exampleDialogs', t('rp.editor.exampleDialogs'), 4)}
      {field('creatorNotes', t('rp.editor.creatorNotes'), 2)}

      <h4>{t('rp.editor.book')}</h4>
      {card.book.length === 0 ? <span className="rp-note">—</span> : null}
      {card.book.map((entry, index) => {
        const patchEntry = (partial: Partial<LoreEntryValue>) => {
          const next = card.book.map((item, itemIndex) => itemIndex === index ? { ...item, ...partial } : item)
          patch({ book: next })
        }
        return (
          <div key={entry.id} className="rp-loreentry">
            <div className="rp-loreentry-head">
              <span className="rp-muted">#{index + 1}</span>
              <span className="rp-spacer" />
              <button className="rp-btn" onClick={() => patch({ book: card.book.filter((_, itemIndex) => itemIndex !== index) })}>{t('rp.editor.book.remove')}</button>
            </div>
            <div className="rp-inline">
              <Field label={t('rp.editor.book.title')}>
                <input value={entry.title} onChange={event => patchEntry({ title: event.target.value })} />
              </Field>
              <Field label={t('rp.editor.book.keys')}>
                <input value={entry.keys.join(', ')} onChange={event => patchEntry({ keys: event.target.value.split(/[,，]/).map(part => part.trim()).filter(Boolean) })} />
              </Field>
            </div>
            <Field label={t('rp.editor.book.content')}>
              <textarea rows={3} value={entry.content} onChange={event => patchEntry({ content: event.target.value })} />
            </Field>
            <div className="rp-inline">
              <Field label={t('rp.editor.book.position')}>
                <select value={entry.position} onChange={event => patchEntry({ position: event.target.value as LoreEntryValue['position'] })}>
                  {LORE_POSITIONS.map(position => <option key={position} value={position}>{position}</option>)}
                </select>
              </Field>
              <Field label={t('rp.editor.book.order')}>
                <input type="number" value={entry.order} onChange={event => patchEntry({ order: Number(event.target.value) || 0 })} />
              </Field>
              <div className="rp-field">
                <label>{t('rp.editor.book.constant')}</label>
                <input type="checkbox" checked={entry.constant} onChange={event => patchEntry({ constant: event.target.checked })} />
              </div>
              <div className="rp-field">
                <label>{t('rp.editor.book.regex')}</label>
                <input type="checkbox" checked={entry.useRegex} onChange={event => patchEntry({ useRegex: event.target.checked })} />
              </div>
            </div>
          </div>
        )
      })}
      <button
        className="rp-btn"
        onClick={() => patch({ book: [...card.book, { id: `lore-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, title: '', content: '', keys: [], useRegex: false, constant: false, position: 'after_char', order: card.book.length * 10 + 100, depth: 4, scanDepth: 0, probability: 100, enabled: true }] })}
      >
        {t('rp.editor.book.add')}
      </button>

      <div className="rp-actions" style={{ marginTop: 12 }}>
        <a className="rp-btn" style={{ textDecoration: 'none' }} href={api.exportPngUrl(cardId)} download>{t('rp.editor.exportPng')}</a>
        <a className="rp-btn" style={{ textDecoration: 'none' }} href={api.exportJsonUrl(cardId)} download>{t('rp.editor.exportJson')}</a>
        <span className="rp-spacer" />
        <button className="rp-btn rp-btn-danger" disabled={busy} onClick={() => void removeCard()}>{t('rp.editor.delete')}</button>
      </div>
    </div>
  )
}
