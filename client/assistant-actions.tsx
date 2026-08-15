/**
 * Role-play additions to the assistant message action strip (the native
 * `conversation.chat.assistant-actions` list slot): regenerate the reply
 * from its own user prompt, and re-roll the illustrations the turn produced.
 * Renders nothing outside role-play sessions.
 */
import { useState, type ReactNode } from 'react'
import { IconEnhanceOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { api } from './api.ts'
import { bumpImageRevs, rewindAndResend, workspaceOfSession } from './runtime.ts'
import { useT } from './i18n.ts'

interface ChatNodeLike {
  kind?: string
  location?: { kind?: string; turn?: { turn: number } }
  data?: Record<string, unknown>
}

interface SnapshotLike {
  chat: {
    order: readonly string[]
    nodes: { get(key: string): ChatNodeLike | undefined }
  }
  turnEnds: ReadonlyMap<number, number>
  running: boolean
}

interface ActionProps {
  messageId?: string
  sessionId?: string
  useSession?: (selector: (snapshot: SnapshotLike) => unknown) => unknown
  useSessions?: (selector: (state: { byId: Record<string, { agentPreset?: string }> }) => unknown) => unknown
  [extra: string]: unknown
}

function turnOf(node: ChatNodeLike): number | undefined {
  const location = node.location
  return location && (location.kind === 'turn' || location.kind === 'step') ? location.turn?.turn : undefined
}

/** Derive the acted-on turn, its opening user text, and its image ids. */
function deriveContext(snapshot: SnapshotLike, messageId: string): {
  turn: number
  userText: string
  prevTurnEnd: number | undefined
  imageIds: string[]
} | undefined {
  let turn: number | undefined
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (node?.kind !== 'assistant-step') continue
    const finalNode = node.data?.finalNode as { messageId?: string } | undefined
    if (finalNode?.messageId === messageId) {
      turn = (node.data?.turn as number | undefined) ?? turnOf(node)
      break
    }
  }
  if (turn === undefined) return undefined
  let userText = ''
  const imageIds: string[] = []
  for (const key of snapshot.chat.order) {
    const node = snapshot.chat.nodes.get(key)
    if (!node || turnOf(node) !== turn) continue
    if (node.kind === 'user' && userText === '') {
      const content = (node.data?.content ?? []) as readonly { type?: string; text?: string }[]
      userText = content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    }
    if (node.kind === 'tool-call') {
      const root = node.data?.root as {
        kind?: string
        call?: { name?: string } | null
        meta?: { images?: { id?: unknown }[] }
      } | undefined
      if (root && 'kind' in root && root.call?.name === 'generate_image' && Array.isArray(root.meta?.images)) {
        for (const image of root.meta.images) {
          if (typeof image.id === 'string') imageIds.push(image.id)
        }
      }
    }
  }
  return { turn, userText, prevTurnEnd: snapshot.turnEnds.get(turn - 1), imageIds }
}

export function RoleplayAssistantActions(props: ActionProps): ReactNode {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const preset = props.useSessions && props.sessionId
    ? (props.useSessions(state => state.byId[props.sessionId as string]?.agentPreset) as string | undefined)
    : undefined
  const snapshot = props.useSession ? (props.useSession(s => s) as SnapshotLike) : undefined
  if (preset !== 'roleplay' || !snapshot || typeof props.messageId !== 'string') return null

  const context = deriveContext(snapshot, props.messageId)
  if (!context) return null
  const canRegenerate = context.prevTurnEnd !== undefined && context.userText.trim() !== '' && !snapshot.running && !busy

  return (
    <>
      <Tooltip label={canRegenerate ? t('rp.regen.reply') : t('rp.regen.unavailable')} side="bottom">
        <button
          type="button"
          className="rp-msg-action"
          disabled={!canRegenerate}
          onClick={() => {
            setBusy(true)
            rewindAndResend(props.sessionId as string, context.prevTurnEnd as number, context.userText)
              .catch(() => setBusy(false))
          }}
        >
          <IconRefreshOutline16 size={16} />
        </button>
      </Tooltip>
      {context.imageIds.length > 0 ? (
        <Tooltip label={t('rp.regen.images')} side="bottom">
          <button
            type="button"
            className="rp-msg-action"
            disabled={busy}
            onClick={() => {
              setBusy(true)
              api.regenerateImages(context.imageIds, props.sessionId ? workspaceOfSession(props.sessionId)?.path : undefined)
                .then(result => bumpImageRevs(result.regenerated))
                .catch(() => {})
                .finally(() => setBusy(false))
            }}
          >
            <IconEnhanceOutline16 size={16} />
          </button>
        </Tooltip>
      ) : null}
    </>
  )
}
