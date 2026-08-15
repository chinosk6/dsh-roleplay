/**
 * The role-play dock above the composer card: character picker / character
 * bar for role-play sessions, and a card picker for BLANK forge sessions
 * (the pick belongs to session creation; once the conversation started the
 * card is fixed). Renders nothing for every other session.
 *
 * While a pending interaction (e.g. the native question card) takes over the
 * composer chain, the whole fallback — this dock included — is hidden by the
 * shell; a compact character bar is then PORTALed into a holder right above
 * the composer seat so the character context never disappears mid-question.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type CardSummary, type ReferenceMode, type RegexScriptValue, type SessionState } from './api.ts'
import { takeResend, workspaceOfSession } from './runtime.ts'
import { colorizeProse, compileCardRules, replaceMacros, startProseHighlighter, type CardColorRule } from './colorize.tsx'
import { useT, tf } from './i18n.ts'

interface DockProps {
  sessionId: string
  useSessions: (selector: (state: { byId: Record<string, { agentPreset?: string; blank: boolean }> }) => unknown) => unknown
  useSession?: (selector: (snapshot: { pending: readonly unknown[]; running: boolean }) => unknown) => unknown
  inputActions: { setDraft(text: string): void; submit(): void }
}

function Avatar({ url, name }: { url: string | null; name: string }) {
  if (url) return <img className="rp-avatar" src={url} alt={name} />
  return <div className="rp-avatar-fallback">{name.slice(0, 1) || '?'}</div>
}

function usePopover(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false)
  return [open, useCallback(() => setOpen(value => !value), []), useCallback(() => setOpen(false), [])]
}

export function RoleplayDock(props: DockProps): React.ReactNode {
  const { sessionId, inputActions } = props
  const preset = props.useSessions(state => state.byId[sessionId]?.agentPreset) as string | undefined
  const blank = props.useSessions(state => state.byId[sessionId]?.blank ?? false) as boolean
  const pending = props.useSession ? ((props.useSession(s => s.pending.length > 0) as boolean) ?? false) : false
  const running = props.useSession ? ((props.useSession(s => s.running) as boolean) ?? false) : false

  // Scope flag for the role-play bubble CSS (styles.ts): set only while a
  // role-play session is current, removed on unmount/session switch, so the
  // styling can never leak into other modes.
  useEffect(() => {
    if (preset !== 'roleplay') return
    document.body.setAttribute('data-rp-active', '1')
    return () => document.body.removeAttribute('data-rp-active')
  }, [preset])

  // A rewind fork staged a resend for this session: fill the draft and send.
  useEffect(() => {
    const text = takeResend(sessionId)
    if (text === undefined) return
    inputActions.setDraft(text)
    const timer = window.setTimeout(() => inputActions.submit(), 80)
    return () => window.clearTimeout(timer)
  }, [sessionId, inputActions])

  if (preset === 'roleplay') {
    return <RoleplayBar sessionId={sessionId} inputActions={inputActions} blank={blank} mode="roleplay" pending={pending} running={running} />
  }
  // Forge sessions pick their card at creation time only; a running forge
  // conversation keeps its card and shows no picker chrome.
  if (preset === 'character-forge' && blank) {
    return <RoleplayBar sessionId={sessionId} inputActions={inputActions} blank={blank} mode="forge" pending={false} running={running} />
  }
  return null
}

/** The player name for client-side macro replacement (loaded once per mount). */
function useUserName(): string {
  const [name, setName] = useState('你')
  useEffect(() => {
    let alive = true
    api.settings()
      .then(result => {
        if (alive && result.value.userName.trim() !== '') setName(result.value.userName.trim())
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return name
}

/**
 * Effect-managed holder prepended to the chat flow column, so the opening
 * message renders as the character's first bubble above the real messages.
 * Re-ensured on an interval: the column only exists once the conversation
 * has its first message, and rerenders may recreate it.
 */
function useOpeningHolder(active: boolean): HTMLElement | null {
  const [holder, setHolder] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) return
    let element: HTMLElement | null = null
    const ensure = () => {
      const container = document.querySelector('[data-chat-flow-kind]')?.parentElement ?? null
      if (!container) return
      if (element && element.parentElement === container && container.firstChild === element) return
      element?.remove()
      element = document.createElement('div')
      element.setAttribute('data-rp-opening', '')
      container.insertBefore(element, container.firstChild)
      setHolder(element)
    }
    ensure()
    const timer = window.setInterval(ensure, 700)
    return () => {
      window.clearInterval(timer)
      element?.remove()
      setHolder(null)
    }
  }, [active])
  return holder
}

type BoundCard = NonNullable<SessionState['card']>

/** The bound card's opening message as a character bubble (macros resolved, prose colored). */
function OpeningBubble({ card, rules }: { card: BoundCard; rules: readonly CardColorRule[] }): React.ReactNode {
  const t = useT()
  const userName = useUserName()
  return (
    <div className="rp-opening">
      <div className="rp-opening-head">
        <Avatar url={card.avatarUrl} name={card.name} />
        <span className="rp-opening-name">{card.name}</span>
        <span className="rp-opening-tag">{t('rp.opening.tag')}</span>
      </div>
      <div className="rp-opening-body">{colorizeProse(replaceMacros(card.firstMessage, card.name, userName), rules)}</div>
    </div>
  )
}

/** Compact opening preview inside the dock (blank sessions, before the first send). */
function OpeningInline({ card, rules }: { card: BoundCard; rules: readonly CardColorRule[] }): React.ReactNode {
  const userName = useUserName()
  return <div className="rp-greeting">{colorizeProse(replaceMacros(card.firstMessage, card.name, userName), rules)}</div>
}

/** Effect-managed holder element inserted just above the composer seat. */
function usePendingHolder(active: boolean): HTMLElement | null {
  const [holder, setHolder] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!active) return
    const seat = document.querySelector('[data-composer-seat]')
    const parent = seat?.parentElement
    if (!seat || !parent) return
    const element = document.createElement('div')
    element.setAttribute('data-rp-question-dock', '')
    parent.insertBefore(element, seat)
    setHolder(element)
    return () => {
      setHolder(null)
      element.remove()
    }
  }, [active])
  return holder
}

function RoleplayBar({ sessionId, inputActions, blank, mode, pending, running }: {
  sessionId: string
  inputActions: DockProps['inputActions']
  blank: boolean
  mode: 'roleplay' | 'forge'
  pending: boolean
  running: boolean
}): React.ReactNode {
  const t = useT()
  const [state, setState] = useState<SessionState | null>(null)
  const [cards, setCards] = useState<CardSummary[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  /** This session's workspace path — recorded on the binding for host-side stores. */
  const wsPath = workspaceOfSession(sessionId)?.path

  const reload = useCallback(() => {
    api.session(sessionId).then(setState).catch(err => setError(String(err instanceof Error ? err.message : err)))
  }, [sessionId])
  useEffect(() => {
    setState(null)
    reload()
  }, [reload])
  // A turn starting consumes the staged one-shot instruction host-side;
  // re-pull the binding on run-state flips so the button state stays honest.
  useEffect(() => {
    if (state) reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])

  const bound = state?.binding?.characterId ? state.card : null
  useEffect(() => {
    if (state && !bound && cards === null) {
      api.cards(wsPath).then(result => setCards(result.cards)).catch(err => setError(String(err instanceof Error ? err.message : err)))
    }
  }, [state, bound, cards, wsPath])

  // Keep the binding's workspace path current — image generation, workspace
  // card lookups and forge card creation on the host resolve through it.
  // Creates the binding when absent (forge sessions may never pick a card).
  useEffect(() => {
    if (!state || !wsPath || state.binding?.workspacePath === wsPath) return
    void api.updateSession(sessionId, { mode, workspacePath: wsPath }).then(reload).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, wsPath, sessionId, mode])

  const pick = useCallback(async (cardId: string) => {
    setBusy(true)
    try {
      await api.updateSession(sessionId, { mode, characterId: cardId, ...(wsPath ? { workspacePath: wsPath } : {}) })
      reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }, [sessionId, mode, reload, wsPath])

  const sendInstruction = useCallback((instruction: string) => {
    inputActions.setDraft(`[系统指令: ${instruction}]`)
    inputActions.submit()
  }, [inputActions])

  const autoImage = state ? (state.binding?.autoImage ?? state.autoImageDefault) : false
  const choiceMode = state ? (state.binding?.choiceMode ?? state.choiceModeDefault) : false
  const holder = usePendingHolder(pending && mode === 'roleplay' && bound !== null)
  // The opening bubble lives at the top of the flow once real messages exist;
  // on a blank session it previews inside the dock instead (no flow column yet).
  const openingHolder = useOpeningHolder(mode === 'roleplay' && !blank && (bound?.firstMessage ?? '').trim() !== '')

  // Prose coloring for native assistant messages: built-in dialogue/thought
  // rules plus the bound card's own coloring regexes. Restarted whenever the
  // card (or its scripts) change; active only for role-play sessions.
  const scriptsJson = JSON.stringify(bound?.regexScripts ?? [])
  const cardRules = useMemo(() => compileCardRules(JSON.parse(scriptsJson) as RegexScriptValue[]), [scriptsJson])
  useEffect(() => {
    if (mode !== 'roleplay') return
    return startProseHighlighter(cardRules)
  }, [mode, cardRules])

  if (!state) return null

  if (!bound) {
    return (
      <div className="rp-dock">
        <div className="rp-dock-row">
          <span className="rp-name">{mode === 'forge' ? t('rp.dock.forge.title') : t('rp.dock.rp.title')}</span>
          <span className="rp-muted">{mode === 'forge' ? t('rp.dock.forge.pick') : t('rp.dock.pick')}</span>
          {error ? <span className="rp-error">{error}</span> : null}
        </div>
        {cards === null ? (
          <span className="rp-muted">{t('rp.dock.loading')}</span>
        ) : cards.length === 0 ? (
          <span className="rp-muted">{t('rp.dock.noCards')}</span>
        ) : (
          <div className="rp-cardgrid">
            {cards.map(card => (
              <button key={`${card.scope}-${card.id}`} className="rp-cardcell" disabled={busy} onClick={() => void pick(card.id)}>
                <Avatar url={card.avatarUrl} name={card.name} />
                <span className="rp-cardcell-text">
                  <span className="rp-cardname">
                    <span className={`rp-scope-tag rp-scope-${card.scope}`}>
                      {card.scope === 'global' ? t('rp.scope.global') : t('rp.scope.workspace')}
                    </span>
                    {card.favorite ? '★ ' : ''}{card.name}
                  </span>
                  <span className="rp-cardnote">{card.creatorNotes || card.description || `${card.bookEntries}${t('rp.cards.lore')}`}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    )
  }

  const isForge = mode === 'forge'
  const toggles = !isForge ? (
    <>
      <button
        className={`rp-btn${autoImage ? ' rp-on' : ''}`}
        title={t('rp.dock.autoImage')}
        onClick={() => {
          void api.updateSession(sessionId, { autoImage: !autoImage }).then(reload).catch(() => {})
        }}
      >
        {t('rp.dock.autoImage')}{autoImage ? t('rp.dock.autoImageOn') : t('rp.dock.autoImageOff')}
      </button>
      {autoImage && state ? (
        <>
          <select
            className="rp-select"
            title={t('rp.dock.count')}
            value={state.binding?.imageCount ?? 0}
            onChange={event => {
              const value = Number(event.target.value)
              void api.updateSession(sessionId, { imageCount: value === 0 ? null : value }).then(reload).catch(() => {})
            }}
          >
            <option value={0}>{tf('rp.dock.countGlobal', { n: state.imageCountDefault })}</option>
            {[1, 2, 3, 4, 5, 6].map(n => (
              <option key={n} value={n}>{tf('rp.dock.countN', { n })}</option>
            ))}
          </select>
          <ReferencePopover sessionId={sessionId} state={state} reload={reload} avatarUrl={bound?.avatarUrl ?? null} />
        </>
      ) : null}
      <button
        className={`rp-btn${choiceMode ? ' rp-on' : ''}`}
        title={t('rp.dock.choiceMode')}
        onClick={() => {
          void api.updateSession(sessionId, { choiceMode: !choiceMode }).then(reload).catch(() => {})
        }}
      >
        {t('rp.dock.choiceMode')}{choiceMode ? t('rp.dock.choiceOn') : t('rp.dock.choiceOff')}
      </button>
    </>
  ) : null

  // Compact bar shown while the composer is taken over by a pending
  // interaction: identity + API-backed toggles only (no send-path buttons —
  // the question card owns text input until it settles).
  const questionBar = holder ? createPortal(
    <div className="rp-dock">
      <div className="rp-dock-row">
        <Avatar url={bound.avatarUrl} name={bound.name} />
        <span className="rp-name">{bound.name}</span>
        <span className="rp-muted">{t('rp.dock.answering')}</span>
        <span className="rp-spacer" />
        {toggles}
      </div>
    </div>,
    holder,
  ) : null

  return (
    <>
      <div className="rp-dock">
        <div className="rp-dock-row">
          <Avatar url={bound.avatarUrl} name={bound.name} />
          <span className="rp-name">{bound.name}</span>
          {isForge ? <span className="rp-muted">{t('rp.dock.forge.editing')}</span> : null}
          <span className="rp-spacer" />
          {toggles}
          {!isForge ? <button className="rp-btn" onClick={() => sendInstruction('请调用 generate_image 为当前场景生成插图')}>{t('rp.dock.imageNow')}</button> : null}
          {!isForge ? (
            <StagedInstruction
              sessionId={sessionId}
              staged={state.binding?.pendingInstruction ?? ''}
              reload={reload}
            />
          ) : null}
          {!isForge ? <button className="rp-btn" onClick={() => { inputActions.setDraft('（继续）'); inputActions.submit() }}>{t('rp.dock.continue')}</button> : null}
          <button
            className="rp-btn"
            onClick={() => {
              void api.updateSession(sessionId, { characterId: null }).then(() => { setCards(null); reload() }).catch(() => {})
            }}
          >
            {isForge ? t('rp.dock.switchCard') : t('rp.dock.switchChar')}
          </button>
        </div>
        {blank && bound.firstMessage ? <OpeningInline card={bound} rules={cardRules} /> : null}
        {error ? <span className="rp-error">{error}</span> : null}
      </div>
      {questionBar}
      {openingHolder && bound.firstMessage ? createPortal(<OpeningBubble card={bound} rules={cardRules} />, openingHolder) : null}
    </>
  )
}

/**
 * Per-session reference-image control, mirroring the settings page's global
 * one: follow-global / none / character avatar / custom upload, with the
 * custom image stored per session on the host.
 */
function ReferencePopover({ sessionId, state, reload, avatarUrl }: {
  sessionId: string
  state: SessionState
  reload: () => void
  avatarUrl: string | null
}): React.ReactNode {
  const t = useT()
  const [open, toggle, close] = usePopover()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stamp, setStamp] = useState(0)
  const [thumbBroken, setThumbBroken] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const override = state.binding?.referenceMode
  const effective = override ?? state.referenceModeDefault
  const modeLabel = (mode: ReferenceMode) => t(`rp.image.ref.${mode}`)

  // The trigger is a thumbnail of the EFFECTIVE reference, not a text label.
  const thumbUrl = effective === 'avatar'
    ? avatarUrl
    : effective === 'custom'
      ? (state.hasSessionReference ? `${api.sessionReferenceUrl(sessionId)}?t=${stamp}` : `${api.referenceUrl()}?t=${stamp}`)
      : null
  useEffect(() => setThumbBroken(false), [thumbUrl])

  const setMode = useCallback((mode: ReferenceMode | null) => {
    void api.updateSession(sessionId, { referenceMode: mode }).then(reload).catch(err => setError(String(err)))
  }, [sessionId, reload])

  const upload = useCallback(async (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    setBusy(true)
    setError('')
    try {
      await api.uploadSessionReference(sessionId, await file.arrayBuffer())
      setStamp(Date.now())
      reload()
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }, [sessionId, reload])

  const options: { value: ReferenceMode | null; label: string }[] = [
    { value: null, label: tf('rp.dock.ref.followGlobal', { mode: modeLabel(state.referenceModeDefault) }) },
    { value: 'none', label: modeLabel('none') },
    { value: 'avatar', label: modeLabel('avatar') },
    { value: 'custom', label: modeLabel('custom') },
  ]

  return (
    <span className="rp-popover">
      <button
        className={`rp-btn rp-ref-thumb${override !== undefined ? ' rp-on' : ''}`}
        title={`${t('rp.dock.reference')}：${modeLabel(effective)}`}
        onClick={toggle}
      >
        {thumbUrl && !thumbBroken
          ? <img src={thumbUrl} alt={modeLabel(effective)} onError={() => setThumbBroken(true)} />
          : <span className="rp-ref-thumb-empty" aria-hidden>⊘</span>}
      </button>
      {open ? (
        <span className="rp-popover-panel">
          {options.map(option => (
            <label key={String(option.value)} className="rp-ref-row">
              <input
                type="radio"
                name={`rp-ref-${sessionId}`}
                checked={(override ?? null) === option.value}
                onChange={() => setMode(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
          {effective === 'custom' ? (
            <span className="rp-actions" style={{ alignItems: 'center' }}>
              <button className="rp-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
                {t('rp.dock.ref.upload')}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/png"
                style={{ display: 'none' }}
                onChange={event => void upload(event.target.files)}
              />
              {state.hasSessionReference || stamp > 0 ? (
                <>
                  <img
                    className="rp-ref-preview"
                    src={`${api.sessionReferenceUrl(sessionId)}?t=${stamp}`}
                    alt=""
                    onError={event => { (event.target as HTMLImageElement).style.display = 'none' }}
                  />
                  <button
                    className="rp-btn rp-btn-danger"
                    disabled={busy}
                    onClick={() => {
                      void api.deleteSessionReference(sessionId).then(() => { setStamp(Date.now()); reload() }).catch(() => {})
                    }}
                  >
                    {t('rp.dock.ref.remove')}
                  </button>
                </>
              ) : (
                <span className="rp-note">{t('rp.dock.ref.fallback')}</span>
              )}
            </span>
          ) : null}
          {error ? <span className="rp-error">{error}</span> : null}
          <span className="rp-actions">
            <button className="rp-btn" onClick={close}>{t('rp.dock.close')}</button>
          </span>
        </span>
      ) : null}
    </span>
  )
}

/**
 * The one-shot stage-direction button: text typed here is STAGED on the
 * session (debounced write to the binding) and rides the next message the
 * user sends from the main composer as a trailing `[系统指令: …]`, then
 * clears automatically — no send button of its own.
 */
function StagedInstruction({ sessionId, staged, reload }: {
  sessionId: string
  staged: string
  reload: () => void
}): React.ReactNode {
  const t = useT()
  const [open, toggle] = usePopover()
  const [text, setText] = useState(staged)
  const ref = useRef<HTMLTextAreaElement | null>(null)
  const saveTimer = useRef<number | undefined>(undefined)

  // Adopt host state (e.g. cleared after a send) while the panel is closed.
  useEffect(() => {
    if (!open) setText(staged)
  }, [staged, open])
  useEffect(() => {
    if (open) ref.current?.focus()
  }, [open])

  const stage = useCallback((value: string) => {
    setText(value)
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      void api.updateSession(sessionId, { pendingInstruction: value.trim() === '' ? null : value })
        .then(reload)
        .catch(() => {})
    }, 400)
  }, [sessionId, reload])

  const active = staged.trim() !== '' || text.trim() !== ''
  return (
    <span className="rp-popover">
      <button className={`rp-btn${active ? ' rp-on' : ''}`} title={t('rp.dock.instruction.title')} onClick={toggle}>
        {t('rp.dock.instruction')}{active ? ' ●' : ''}
      </button>
      {open ? (
        <span className="rp-popover-panel">
          <textarea
            ref={ref}
            className="rp-textarea"
            placeholder={t('rp.dock.instruction.hint')}
            value={text}
            onChange={event => stage(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') toggle()
            }}
          />
          <span className="rp-note">{t('rp.dock.instruction.note')}</span>
        </span>
      ) : null}
    </span>
  )
}
