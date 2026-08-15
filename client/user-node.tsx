/**
 * Keyed shadow of the `user` chat node.
 *
 * Non-role-play sessions (and any message carrying non-text blocks) are
 * DELEGATED verbatim to the shadowed native renderer looked up from the slot
 * registry, so nothing outside role-play changes by a pixel. Text-only user
 * messages in role-play sessions render the same bubble visual language plus
 * an in-place edit affordance: confirming an edit forks the session at the
 * previous turn boundary (the append-only-log equivalent of rewriting
 * history), rebinds the character, and resends the edited text.
 */
import { createElement, useState, type ReactNode } from 'react'
import {
  IconCloseOutline16,
  IconCopyOutline16,
  IconEditOutline16,
  IconSendOutline16,
  MessageText,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { nativeChatNodeComponent, rewindAndResend } from './runtime.ts'
import { useT } from './i18n.ts'

interface TurnLocationLike {
  turn: number
}

interface SnapshotLike {
  turnEnds: ReadonlyMap<number, number>
  running: boolean
}

interface UserNodeProps {
  sessionId?: string
  useSessions?: (selector: (state: { byId: Record<string, { agentPreset?: string }> }) => unknown) => unknown
  useSession?: (selector: (snapshot: SnapshotLike) => unknown) => unknown
  node?: {
    data?: { content?: readonly { type?: string; text?: string }[] }
    location?: { kind?: string; turn?: TurnLocationLike }
  }
  [extra: string]: unknown
}

function textOf(content: readonly { type?: string; text?: string }[]): { text: string; textOnly: boolean } {
  let text = ''
  let textOnly = true
  for (const block of content) {
    if (block.type === 'text') text += block.text ?? ''
    else textOnly = false
  }
  return { text, textOnly }
}

/** Split a trailing one-shot `[系统指令: …]` off the message body for display. */
function splitInstruction(text: string): { body: string; instruction: string | undefined } {
  const match = text.match(/\n*\[系统指令:\s?([\s\S]*)\]\s*$/)
  if (!match || match.index === undefined) return { body: text, instruction: undefined }
  return { body: text.slice(0, match.index).trimEnd(), instruction: match[1] }
}

export function RoleplayUserNode(props: UserNodeProps): ReactNode {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  // The selector hooks are framework-supplied and present for every render of
  // this session-scope entry, so the optional calls keep a stable hook order.
  const preset = props.useSessions
    ? (props.useSessions(state => state.byId[(props.sessionId as string) ?? '']?.agentPreset) as string | undefined)
    : undefined
  const snapshot = props.useSession ? (props.useSession(s => s) as SnapshotLike) : undefined
  const content = props.node?.data?.content ?? []
  const { text, textOnly } = textOf(content)
  const location = props.node?.location
  const turnNumber = location && (location.kind === 'turn' || location.kind === 'step') ? location.turn?.turn : undefined
  const prevTurnEnd = turnNumber !== undefined ? snapshot?.turnEnds.get(turnNumber - 1) : undefined
  const running = snapshot?.running ?? false

  if (preset !== 'roleplay' || !textOnly) {
    const native = nativeChatNodeComponent('user', RoleplayUserNode)
    return native ? createElement(native as never, props as never) : null
  }

  const canEdit = prevTurnEnd !== undefined && !running && !busy
  const copy = () => {
    void writeClipboard(text).then(ok => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1000)
    })
  }
  const confirmEdit = () => {
    if (!canEdit || draft.trim() === '') return
    setBusy(true)
    rewindAndResend(props.sessionId as string, prevTurnEnd, draft)
      .catch(() => setBusy(false))
  }

  if (editing) {
    return (
      <div className="rp-user-row">
        <div className="rp-user-stack" style={{ width: '100%' }}>
          <textarea
            className="rp-textarea rp-user-edit"
            value={draft}
            autoFocus
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) confirmEdit()
              if (event.key === 'Escape') setEditing(false)
            }}
          />
          <div className="rp-msg-actions" style={{ opacity: 1 }}>
            <span className="rp-note">{t('rp.edit.hint')}</span>
            <Tooltip label={t('rp.edit.send')} side="bottom">
              <button type="button" className="rp-msg-action" disabled={!canEdit || draft.trim() === ''} onClick={confirmEdit}>
                <IconSendOutline16 size={16} />
              </button>
            </Tooltip>
            <Tooltip label={t('rp.edit.cancel')} side="bottom">
              <button type="button" className="rp-msg-action" onClick={() => setEditing(false)}>
                <IconCloseOutline16 size={16} />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    )
  }

  const { body, instruction } = splitInstruction(text)
  return (
    <div className="rp-user-row" data-time-hover-root>
      <div className="rp-user-stack">
        <div className="rp-user-bubble">
          <MessageText text={body} />
          {instruction !== undefined ? (
            <div className="rp-user-instruction">⚙ {instruction}</div>
          ) : null}
        </div>
      </div>
      <div className="rp-msg-actions">
        <Tooltip label={canEdit ? t('rp.edit.button') : t('rp.edit.unavailable')} side="bottom">
          <button
            type="button"
            className="rp-msg-action"
            disabled={!canEdit}
            onClick={() => {
              setDraft(text)
              setEditing(true)
            }}
          >
            <IconEditOutline16 size={16} />
          </button>
        </Tooltip>
        <Tooltip label={copied ? t('rp.chat.copied') : t('rp.chat.copy')} side="bottom">
          <button type="button" className="rp-msg-action" onClick={copy}>
            <IconCopyOutline16 size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
