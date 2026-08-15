/**
 * The image-gallery sub-page of the「角色扮演」settings section: disk usage
 * bar, a starred shelf, and a multi-select grid with star/delete actions.
 * Generated images are already persisted host-side; this page manages them.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, formatBytes, type GalleryImage, type GalleryUsage } from './api.ts'
import { imageUrlWithRev } from './runtime.ts'
import { useT, tf } from './i18n.ts'

function UsageBar({ usage }: { usage: GalleryUsage }): ReactNode {
  const t = useT()
  const total = usage.usedBytes + usage.freeBytes
  const ratio = total > 0 ? Math.min(1, usage.usedBytes / total) : 0
  return (
    <div className="rp-usage">
      <div className="rp-usage-labels">
        <span>{tf('rp.gallery.used', { used: formatBytes(usage.usedBytes) })}</span>
        <span>{tf('rp.gallery.free', { free: formatBytes(usage.freeBytes) })}</span>
      </div>
      <div className="rp-usage-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={t('rp.gallery.title')}>
        <div className="rp-usage-fill" style={{ width: `${Math.max(0.5, ratio * 100)}%` }} />
      </div>
    </div>
  )
}

function Tile({ image, selected, onToggleSelect, onToggleStar }: {
  image: GalleryImage
  selected: boolean
  onToggleSelect: () => void
  onToggleStar: () => void
}): ReactNode {
  const t = useT()
  return (
    <div className={`rp-tile${selected ? ' rp-tile-selected' : ''}`}>
      <img src={imageUrlWithRev(image.url, image.id)} alt="" loading="lazy" title={image.prompt} onClick={onToggleSelect} />
      <button
        type="button"
        className={`rp-tile-star${image.starred ? ' rp-on' : ''}`}
        title={image.starred ? t('rp.gallery.unstar') : t('rp.gallery.star')}
        onClick={onToggleStar}
      >
        {image.starred ? '★' : '☆'}
      </button>
      <span className={`rp-tile-check${selected ? ' rp-on' : ''}`} aria-hidden>✓</span>
      <span className="rp-tile-size">{formatBytes(image.size)}</span>
    </div>
  )
}

export function ImageGalleryPage({ onClose }: { onClose: () => void }): ReactNode {
  const t = useT()
  const [images, setImages] = useState<GalleryImage[] | null>(null)
  const [usage, setUsage] = useState<GalleryUsage | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    api.images()
      .then(result => {
        setImages(result.images)
        setUsage(result.usage)
        setSelected(current => new Set([...current].filter(id => result.images.some(image => image.id === id))))
      })
      .catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [])
  useEffect(reload, [reload])

  const toggleSelect = useCallback((id: string) => {
    setSelected(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleStar = useCallback((image: GalleryImage) => {
    void api.starImage(image.id, !image.starred).then(reload).catch(err => setError(String(err)))
  }, [reload])

  const deleteSelected = useCallback(() => {
    const ids = [...selected]
    if (ids.length === 0) return
    if (!window.confirm(tf('rp.gallery.confirmDelete', { count: ids.length }))) return
    setBusy(true)
    api.deleteImages(ids)
      .then(reload)
      .catch(err => setError(String(err instanceof Error ? err.message : err)))
      .finally(() => setBusy(false))
  }, [selected, reload])

  const starred = images?.filter(image => image.starred) ?? []
  const rest = images?.filter(image => !image.starred) ?? []

  return (
    <div className="rp-settings">
      <div className="rp-editor-head">
        <button className="rp-btn" onClick={onClose}>← {t('rp.gallery.back')}</button>
        <span className="rp-editor-title">{t('rp.gallery.title')}</span>
        <span className="rp-spacer" />
        {images !== null && images.length > 0 ? (
          <span className="rp-actions">
            <button
              className="rp-btn"
              disabled={busy || images.length === 0}
              onClick={() => setSelected(current => (current.size === images.length ? new Set() : new Set(images.map(image => image.id))))}
            >
              {selected.size === images.length && images.length > 0 ? t('rp.gallery.clearSelect') : t('rp.gallery.selectAll')}
            </button>
            <button className="rp-btn rp-btn-danger" disabled={busy || selected.size === 0} onClick={deleteSelected}>
              {tf('rp.gallery.deleteSelected', { count: selected.size })}
            </button>
          </span>
        ) : null}
      </div>
      {usage ? <UsageBar usage={usage} /> : null}
      {error ? <div className="rp-error">{error}</div> : null}
      {images === null ? (
        <span className="rp-note">{t('rp.gallery.loading')}</span>
      ) : images.length === 0 ? (
        <span className="rp-note">{t('rp.gallery.empty')}</span>
      ) : (
        <>
          {starred.length > 0 ? (
            <div>
              <h4>{t('rp.gallery.starred')}</h4>
              <div className="rp-tilegrid">
                {starred.map(image => (
                  <Tile
                    key={image.id}
                    image={image}
                    selected={selected.has(image.id)}
                    onToggleSelect={() => toggleSelect(image.id)}
                    onToggleStar={() => toggleStar(image)}
                  />
                ))}
              </div>
            </div>
          ) : null}
          <div>
            <h4>{t('rp.gallery.all')}</h4>
            <div className="rp-tilegrid">
              {rest.map(image => (
                <Tile
                  key={image.id}
                  image={image}
                  selected={selected.has(image.id)}
                  onToggleSelect={() => toggleSelect(image.id)}
                  onToggleStar={() => toggleStar(image)}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
