/** Keyed tool-call renderers for the plugin's model tools. */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api } from './api.ts'
import { CardEditor } from './card-editor.tsx'
import { bumpImageRevs, imageRev, imageUrlWithRev, recentWorkspace, subscribeImageRevs } from './runtime.ts'
import { useT } from './i18n.ts'

interface ToolViewProps {
  callId: string
  toolName: string
  /** Frozen running call or settled result node (settled forms carry `kind`). */
  block: Record<string, unknown>
}

function parseArgs(block: Record<string, unknown>): Record<string, unknown> {
  // Running calls carry `argsRaw` at the top level; settled result nodes
  // carry the call head under `call.argsRaw`.
  const settled = block as { call?: { argsRaw?: string } | null; argsRaw?: string; arguments?: string }
  const raw = settled.call?.argsRaw ?? settled.argsRaw ?? settled.arguments
  if (typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isSettled(block: Record<string, unknown>): boolean {
  return 'kind' in block
}

function metaOf(block: Record<string, unknown>): Record<string, unknown> | undefined {
  const meta = (block as { meta?: unknown }).meta
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : undefined
}

export function GenerateImageView({ block }: ToolViewProps): ReactNode {
  const t = useT()
  const args = parseArgs(block)
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (!isSettled(block)) {
    return (
      <div className="rp-toolcard rp-genimg">
        <span className="rp-toolcard-title">{t('rp.tool.genRunning')}{prompt ? `（${prompt.slice(0, 80)}）` : ''}</span>
      </div>
    )
  }
  const meta = metaOf(block)
  const images = Array.isArray(meta?.images) ? (meta.images as { id?: unknown; url?: unknown; width?: unknown; height?: unknown }[]) : []
  const isError = (block as { isError?: boolean }).isError === true
  if (isError || images.length === 0) {
    const content = (block as { content?: { type?: string; text?: string }[] }).content
    const text = Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : ''
    return (
      <div className="rp-toolcard rp-genimg">
        <span className="rp-toolcard-title">{isError ? t('rp.tool.genFailed') : t('rp.tool.genDone')}</span>
        {text ? <span className="rp-note">{text}</span> : null}
      </div>
    )
  }
  return (
    <div className="rp-toolcard rp-genimg rp-genimg-images">
      <span className="rp-toolcard-title">{t('rp.tool.genTitle')} · {prompt.slice(0, 100)}</span>
      <div className="rp-imggrid">
        {images.map((image, index) =>
          typeof image.url === 'string'
            ? (
                <GeneratedImage
                  key={String(image.id ?? index)}
                  url={image.url}
                  id={typeof image.id === 'string' ? image.id : ''}
                  width={typeof image.width === 'number' ? image.width : undefined}
                  height={typeof image.height === 'number' ? image.height : undefined}
                />
              )
            : null,
        )}
      </div>
    </div>
  )
}

/** The scrollable ancestor that owns the conversation viewport. */
function nearestScroller(element: HTMLElement): HTMLElement | null {
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (current.scrollHeight > current.clientHeight + 20) {
      const overflow = getComputedStyle(current).overflowY
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return current
    }
  }
  return null
}

/**
 * If the user was following the conversation (near the bottom), keep them
 * pinned there after `element` changed the page height — an asynchronously
 * arriving image must not silently break the auto-scroll.
 */
function stickToBottom(element: HTMLElement): void {
  const scroller = nearestScroller(element)
  if (!scroller) return
  const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
  if (distance < 480) scroller.scrollTop = scroller.scrollHeight
}

/**
 * One generated image. Background generation means the file may not exist
 * yet when this renders: a load failure flips the tile into a waiting state
 * that polls the readiness endpoint until the file lands (then reloads via a
 * rev bump) or the task reports failure. Known output dimensions size the
 * waiting tile (and the img box) like the final image, so the swap shifts
 * little layout — but they are the REQUESTED size, and some backends only
 * honor the aspect ratio (or pick their own size). Once the file loads, its
 * natural dimensions replace the declared ones so the thumbnail is never
 * stretched to a mismatched box.
 */
function GeneratedImage({ url, id, width, height }: {
  url: string
  id: string
  width?: number | undefined
  height?: number | undefined
}): ReactNode {
  const t = useT()
  const [zoomed, setZoomed] = useState(false)
  const [phase, setPhase] = useState<'show' | 'waiting' | 'failed'>('show')
  const [reason, setReason] = useState('')
  // Actual file dimensions, read once the image loads (see the doc comment).
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  // Guard against a ready-verdict/404 flicker loop (e.g. a truncated write).
  const retries = useRef(0)
  // The image arrived asynchronously at least once → re-pin the scroll on load.
  const arrivedLate = useRef(false)
  // Re-render (with a cache-busting query) after regeneration or readiness.
  useSyncExternalStore(subscribeImageRevs, () => imageRev(id))

  // Display box under the grid's 280×340 cap: from the actual file size once
  // loaded, from the declared output size before that (placeholder sizing).
  const source = natural ?? (width && height ? { width, height } : undefined)
  const scale = source ? Math.min(280 / source.width, 340 / source.height, 1) : undefined
  const box = source && scale
    ? { width: Math.round(source.width * scale), height: Math.round(source.height * scale) }
    : undefined

  // The ratio correction can change the tile height after the load event —
  // re-pin the viewport the same way a late-arriving image does.
  useEffect(() => {
    if (natural && imgRef.current) stickToBottom(imgRef.current)
  }, [natural])

  // Workspace-stored images carry their workspace in the URL query; the
  // readiness endpoint needs the same context to find the file.
  const wsParam = (() => {
    try {
      return new URL(url, window.location.origin).searchParams.get('ws') ?? undefined
    } catch {
      return undefined
    }
  })()

  useEffect(() => {
    if (phase !== 'waiting' || !id) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const { states } = await api.imageStates([id], wsParam)
        if (!alive) return
        const state = states[id]
        if (state?.status === 'ready') {
          bumpImageRevs([id])
          setPhase('show')
          return
        }
        if (state?.status === 'failed') {
          setReason(state.error ?? '')
          setPhase('failed')
          return
        }
      } catch {
        // transient poll error: keep waiting
      }
      if (alive) timer = setTimeout(poll, 2500)
    }
    timer = setTimeout(poll, 1200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [phase, id, wsParam])

  if (phase === 'failed') {
    return <div className="rp-imgtile rp-imgfail" style={box}>{t('rp.tool.genFailed')}{reason ? `：${reason}` : ''}</div>
  }
  if (phase === 'waiting') {
    return (
      <div className="rp-imgtile rp-imgwait" style={box}>
        <span className="rp-imgspin" />
        {t('rp.tool.genWaiting')}
      </div>
    )
  }
  return (
    <img
      ref={imgRef}
      src={imageUrlWithRev(url, id)}
      alt=""
      {...(box ? { width: box.width, height: box.height } : {})}
      style={zoomed ? { maxWidth: '100%', maxHeight: 'none', width: 'auto', height: 'auto' } : undefined}
      onClick={() => setZoomed(value => !value)}
      onLoad={event => {
        const el = event.currentTarget
        if (el.naturalWidth > 0 && el.naturalHeight > 0
          && (natural?.width !== el.naturalWidth || natural?.height !== el.naturalHeight)) {
          setNatural({ width: el.naturalWidth, height: el.naturalHeight })
        }
        if (arrivedLate.current) {
          arrivedLate.current = false
          stickToBottom(el)
        }
      }}
      onError={() => {
        arrivedLate.current = true
        retries.current += 1
        if (retries.current > 8) {
          setReason('')
          setPhase('failed')
        } else {
          setPhase('waiting')
        }
      }}
    />
  )
}

/**
 * The forge-mode result card: the freshly generated card rendered as an
 * interactive, editable surface — no separate editor visit needed.
 */
export function SaveCardView({ block }: ToolViewProps): ReactNode {
  const t = useT()
  if (!isSettled(block)) {
    return (
      <div className="rp-toolcard">
        <span className="rp-toolcard-title">{t('rp.tool.cardRunning')}</span>
      </div>
    )
  }
  const meta = metaOf(block)
  const cardId = typeof meta?.card_id === 'string' ? meta.card_id : undefined
  const name = typeof meta?.name === 'string' ? meta.name : undefined
  const isError = (block as { isError?: boolean }).isError === true
  if (isError || !cardId) {
    return (
      <div className="rp-toolcard">
        <span className="rp-toolcard-title">{isError ? t('rp.tool.cardFailed') : t('rp.tool.cardSaved')}</span>
      </div>
    )
  }
  return (
    <div className="rp-toolcard rp-forge-result">
      <div className="rp-toolcard-head">
        <span className="rp-toolcard-title">
          {t('rp.tool.cardSaved')}{name ? ` · ${name}` : ''}
        </span>
        <span className="rp-note">{t('rp.tool.cardHint')}</span>
      </div>
      <CardEditor cardId={cardId} ws={recentWorkspace()?.path} />
      <span className="rp-note">{t('rp.tool.cardManage')}</span>
    </div>
  )
}
