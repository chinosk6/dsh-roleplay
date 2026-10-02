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
  IconCloseOutlineRegular,
  IconCopyOutlineRegular,
  IconEditOutlineRegular,
  IconSendOutlineRegular,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { nativeKeyedComponent, rewindAndResend } from './runtime.ts'
import { turnOf, useAgentPreset, useChatFlow, useSessionRunning, type SessionSlotProps } from './compat.ts'
import { useT } from './i18n.ts'

interface UserNodeProps extends SessionSlotProps {
  node?: {
    data?: { content?: readonly { type?: string; text?: string }[] }
    location?: { kind?: string; turn?: { turn: number } }
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
  const preset = useAgentPreset(props, props.sessionId)
  const flow = useChatFlow(props)
  const running = useSessionRunning(props)
  const content = props.node?.data?.content ?? []
  const { text, textOnly } = textOf(content)
  const turnNumber = turnOf(props.node)
  const prevTurnEnd = turnNumber !== undefined ? flow?.turnEnds.get(turnNumber - 1) : undefined

  if (preset !== 'roleplay' || !textOnly) {
    const native = nativeKeyedComponent('conversation.chat.node', 'user', RoleplayUserNode)
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
                <IconSendOutlineRegular size={16} />
              </button>
            </Tooltip>
            <Tooltip label={t('rp.edit.cancel')} side="bottom">
              <button type="button" className="rp-msg-action" onClick={() => setEditing(false)}>
                <IconCloseOutlineRegular size={16} />
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
          {/* Plain pre-wrap text, the way the native user bubble draws it.
              Rendered here rather than through the primitives' text component:
              that export was dropped in dsh 0.1.5, and a primitive that is
              gone arrives as `undefined`, i.e. a render crash. The
              .rp-user-text class carries the white-space/word-break its own
              CSS used to provide. */}
          <div className="rp-user-text">{body}</div>
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
            <IconEditOutlineRegular size={16} />
          </button>
        </Tooltip>
        <Tooltip label={copied ? t('rp.chat.copied') : t('rp.chat.copy')} side="bottom">
          <button type="button" className="rp-msg-action" onClick={copy}>
            <IconCopyOutlineRegular size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
