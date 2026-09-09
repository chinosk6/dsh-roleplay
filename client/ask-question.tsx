/**
 * Keyed shadow of the native `ask_user_question` tool row — the card choice
 * mode answers through.
 *
 * The shipped row is good and stays in charge of every ordinary case: it
 * renders a waiting state while the question is open and a paired
 * question/answer transcript once it settles. What it cannot do is show a
 * question that never reached an answer: `questionEntries` keeps only each
 * question's id and text, so when the call ends in an error — most often
 * "interrupted after it was recorded, but no result was durably recorded",
 * i.e. the harness stopped while the card was still open — the row falls back
 * to printing the raw arguments JSON and the options are simply lost.
 *
 * In a role-play session those options ARE the story's next move, so this
 * component takes that one case over: it lists them as buttons that send the
 * pick as the next message, which resumes the scene without the player having
 * to retype an option by hand. Everything else — and every session outside
 * role-play — is DELEGATED to the shadowed native row verbatim.
 */
import { createElement, type ReactNode } from 'react'
import { nativeKeyedComponent } from './runtime.ts'
import { useAgentPreset, type SessionSlotProps } from './compat.ts'
import { useT } from './i18n.ts'

interface AskQuestionProps extends SessionSlotProps {
  block?: Record<string, unknown>
  inputActions?: { setDraft(text: string): void; submit(): void }
  [extra: string]: unknown
}

interface Question {
  question: string
  header?: string
  options: string[]
}

/** Settled result nodes carry `kind`; a running call does not. */
function isSettled(block: Record<string, unknown>): boolean {
  return 'kind' in block
}

function argsRawOf(block: Record<string, unknown>): string | undefined {
  const shape = block as { call?: { argsRaw?: string } | null; argsRaw?: string }
  const raw = shape.call?.argsRaw ?? shape.argsRaw
  return typeof raw === 'string' ? raw : undefined
}

/** The asked questions with their option labels, or none when unreadable. */
function questionsOf(block: Record<string, unknown>): Question[] {
  const raw = argsRawOf(block)
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  const list = (parsed as { questions?: unknown } | null)?.questions
  if (!Array.isArray(list)) return []
  const questions: Question[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as { question?: unknown; header?: unknown; options?: unknown }
    if (typeof row.question !== 'string') continue
    const options: string[] = []
    if (Array.isArray(row.options)) {
      for (const option of row.options) {
        const label = (option as { label?: unknown } | null)?.label
        if (typeof label === 'string' && label.trim() !== '') options.push(label)
      }
    }
    questions.push({
      question: row.question,
      ...(typeof row.header === 'string' ? { header: row.header } : {}),
      options,
    })
  }
  return questions
}

export function RoleplayAskQuestionView(props: AskQuestionProps): ReactNode {
  const t = useT()
  const preset = useAgentPreset(props, props.sessionId)
  const block = props.block ?? {}
  // An unanswered question is one whose call settled as an error: cancelled,
  // aborted, or (the common one) interrupted with no durable result.
  const unanswered = isSettled(block) && (block as { isError?: boolean }).isError === true
  const questions = unanswered ? questionsOf(block) : []

  if (preset !== 'roleplay' || questions.length === 0) {
    const native = nativeKeyedComponent('tool.call.toolview', 'ask_user_question', RoleplayAskQuestionView)
    return native ? createElement(native as never, props as never) : null
  }

  const send = (label: string) => {
    const actions = props.inputActions
    if (!actions) return
    actions.setDraft(label)
    actions.submit()
  }

  return (
    <div className="rp-toolcard rp-askcard">
      <span className="rp-toolcard-title">{t('rp.ask.unanswered')}</span>
      {questions.map((question, index) => (
        <div key={index} className="rp-askblock">
          <span className="rp-askquestion">{question.header ? `${question.header} · ` : ''}{question.question}</span>
          {question.options.length === 0 ? (
            <span className="rp-note">{t('rp.ask.noOptions')}</span>
          ) : (
            <div className="rp-askoptions">
              {question.options.map(label => (
                <button key={label} type="button" className="rp-btn" onClick={() => send(label)}>{label}</button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="rp-note">{t('rp.ask.pickHint')}</span>
    </div>
  )
}
