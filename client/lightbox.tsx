/**
 * Original-image preview layer for generated illustrations, mirroring the
 * harness's built-in attachment lightbox (same tokens, layout and dismissal
 * behavior) — the harness keeps that component internal to its attachment
 * plugin, so it cannot be imported. Closes on Escape, backdrop press, or the
 * close control, and restores focus to the opener on unmount. Rendered
 * through a body portal: an opener inside a transformed or filtered ancestor
 * would otherwise trap the fixed backdrop in that ancestor's box instead of
 * covering the viewport.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { useT } from './i18n.ts'

export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }): ReactNode {
  const t = useT()
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      restoreRef.current?.focus()
    }
  }, [onClose])
  return createPortal(
    <div className="rp-lightbox" role="dialog" aria-modal="true" aria-label={t('rp.image.preview')}>
      <div className="rp-lightbox-mask" aria-hidden="true" onMouseDown={onClose} />
      <img className="rp-lightbox-img" src={src} alt="" />
      <button ref={closeRef} type="button" className="rp-lightbox-close" aria-label={t('rp.image.closePreview')} onClick={onClose}>
        <IconCloseOutline16 size={16} />
      </button>
    </div>,
    document.body,
  )
}
