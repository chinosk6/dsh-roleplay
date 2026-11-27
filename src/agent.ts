/**
 * Session-plane plugin, mounted only through the two agent presets this
 * bundle declares (cordis.patch.yml). It contributes the mode persona
 * (shadowing the global deployment persona for its preset's sessions), the
 * per-session character context, and the model-facing tools. The file/web
 * tool grants are enforced from the host plane (src/tool-grants.ts).
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import {
  applyMacros,
  autoImageSection,
  cardPostHistoryContext,
  characterSection,
  choiceModeSection,
  detectImageIntent,
  escapeBraces,
  forgeBoundCardSection,
  forgePersona,
  loreContext,
  noAutoImageSection,
  nsfwEnhanceSection,
  roleplayStandingRules,
  selectLore,
  unboundHint,
} from './prompts.ts'
import { PERSONA_SECTION_NAME, personaSectionOrder } from './dsh-compat.ts'
import { editBook, replaceBook } from './cards/book-edit.ts'
import { resolveUploadedImagePng } from './uploads.ts'
import { GLOBAL_IMAGE_TOOL_NAME, registerImageTool } from './image-tool.ts'
import type {} from './service.ts'

export const name = 'roleplay-agent'
export const inject = ['roleplay', 'systemPrompt', 'tools']

export interface Config {
  mode: 'roleplay' | 'forge'
}

export const Config: z<Config> = z.object({
  mode: z.union(['roleplay', 'forge']).default('roleplay'),
})

/**
 * JSON as a `{ type: 'json' }` tool output accepts it. Declared here rather
 * than imported: the harness moved this type between packages (dsh-tools →
 * dsh-util-values), and a type-only need is not worth that version coupling.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/**
 * Producer-owned message source for the messages this plugin injects. dsh 0.2
 * retired the generic `{ kind: 'plugin', plugin }` wrapper (session format v4
 * refuses it) and lifts old records to `plugin:<name>`; using the same kind
 * keeps new and migrated messages alike.
 */
const ROLEPLAY_SOURCE = 'plugin:dsh-roleplay'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-roleplay': { kind: 'plugin:dsh-roleplay' }
  }
}

/**
 * The part of the harness approval service (`approval`) the delete tool uses.
 * Declared here rather than imported, like the registries in tool-grants.ts:
 * the service is optional in a composition and only this one call is needed.
 */
interface ApprovalLike {
  /** Put one decision to the user; only `'allowed-once'` is a grant. */
  request(req: {
    agent: Agent
    toolName: string
    callId?: string
    /** Audited reason, also the prompt text when no localized one is given. */
    reason?: string
    displayReason?: { readonly en: string; readonly [locale: string]: string }
    signal?: AbortSignal
  }): Promise<string>
}

type DerivedMessage = { role?: string; content?: unknown; source?: { kind?: string } }

/** A message the human actually typed (not a runtime-context snapshot or plugin steer). */
function isHumanMessage(message: DerivedMessage | undefined): boolean {
  return message?.role === 'user' && message.source?.kind === 'user'
}

/**
 * Derived messages up to and including the latest human message.
 *
 * dsh 0.2 re-assembles the runtime contexts before EVERY step of a turn and
 * appends a fresh snapshot whenever the rendered text differs. Inputs read
 * from the in-progress tail (the previous snapshot, tool results, the
 * assistant's half-written reply) would make the snapshot drift mid-turn and
 * re-issue per-turn directives — e.g. "本轮必须生图" right after the image was
 * generated. Cutting at the human message keeps every input stable for the
 * whole turn.
 */
function turnInputMessages(agent: Agent): DerivedMessage[] {
  const messages = agent.session.deriveMessages() as readonly DerivedMessage[]
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanMessage(messages[i])) return messages.slice(0, i + 1).filter(m => m.source?.kind !== 'runtime-context')
  }
  return messages.filter(m => m.source?.kind !== 'runtime-context')
}

/** Concatenated text of the last few derived messages, for lore keyword scans. */
function recentText(agent: Agent | undefined): string {
  if (!agent) return ''
  try {
    const texts: string[] = []
    for (const message of turnInputMessages(agent).slice(-6)) {
      const content = (message as { content?: unknown }).content
      if (typeof content === 'string') {
        texts.push(content)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
            texts.push(String((block as { text?: unknown }).text ?? ''))
          }
        }
      }
    }
    return texts.join('\n')
  } catch {
    return ''
  }
}

function agentOf(context: AssembleContext): Agent | undefined {
  return (context as AssembleContext & { agent?: Agent }).agent
}

/**
 * Text of the latest human message, for image-intent detection. Skips the
 * runtime-context snapshots (also user-role): their own "插图规则" wording
 * would otherwise read as an image request from the second step on.
 */
function lastUserText(agent: Agent | undefined): string {
  if (!agent) return ''
  try {
    const messages = agent.session.deriveMessages() as readonly DerivedMessage[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (!message || !isHumanMessage(message)) continue
      if (typeof message.content === 'string') return message.content
      if (Array.isArray(message.content)) {
        return message.content
          .filter((block): block is { type: string; text?: string } =>
            !!block && typeof block === 'object' && (block as { type?: string }).type === 'text')
          .map(block => block.text ?? '')
          .join('')
      }
      return ''
    }
  } catch {
    // fall through
  }
  return ''
}

/**
 * This session's event log.
 *
 * dsh 0.1.2 removed the `events` getter in favour of `snapshotEvents()` (a
 * cached immutable range read over the same append-only log), so the plugin
 * asks for whichever accessor the running harness has.
 */
function sessionEvents(session: Agent['session']): readonly SessionEvent[] {
  const log = session as unknown as {
    snapshotEvents?: () => readonly SessionEvent[]
    events?: readonly SessionEvent[]
  }
  if (typeof log.snapshotEvents === 'function') return log.snapshotEvents()
  return log.events ?? []
}

/** Whether the turn already offered its options through the native question tool. */
function calledAskUserQuestion(agent: Agent, turn: number): boolean {
  const events = sessionEvents(agent.session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'turn/start' && event.data.turn === turn) return false
    if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === 'ask_user_question') return true
  }
  return false
}

export function apply(ctx: Context, config: Config): void {
  const service = () => ctx.roleplay

  // Both modes have their own scoped generate_image; the host-plane global
  // variant would only confuse the model with a second image tool.
  blockGlobalImageTool(ctx)

  if (config.mode === 'forge') {
    ctx.systemPrompt.variable('user_macro', () => '{{user}}')
    ctx.systemPrompt.variable('char_macro', () => '{{char}}')
    ctx.systemPrompt.section({
      name: PERSONA_SECTION_NAME,
      order: personaSectionOrder(ctx),
      text: () => [forgePersona(), nsfwEnhanceSection()].join('\n\n'),
    })
    ctx.systemPrompt.section({
      name: 'roleplay:forge-card',
      order: 10,
      text: (context) => {
        const svc = service()
        const agent = agentOf(context)
        const binding = agent ? svc.getBinding(String(agent.id)) : undefined
        const card = binding?.characterId ? svc.getCard(binding.characterId, binding.workspacePath) : undefined
        if (!card) return ''
        return escapeBraces(forgeBoundCardSection(card))
      },
    })
    registerForgeTools(ctx)
    registerImageTool(ctx, { background: false, uploadReference: true, avatarReference: true })
    return
  }

  // ── role-play mode ──
  ctx.systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    order: personaSectionOrder(ctx),
    text: (context) => {
      const svc = service()
      const settings = svc.settings.get()
      const agent = agentOf(context)
      const binding = agent ? svc.getBinding(String(agent.id)) : undefined
      const card = binding?.characterId ? svc.getCard(binding.characterId, binding.workspacePath) : undefined
      const parts = [roleplayStandingRules(settings.userName)]
      if (card) {
        parts.push(characterSection(card, settings.userName, settings.userPersona, recentText(agent)))
      } else {
        parts.push(unboundHint())
      }
      return escapeBraces(parts.join('\n\n'))
    },
  })
  // ── dynamic runtime contexts ──
  // These render as a user-role snapshot AFTER the retained history — the
  // near-the-latest-message injection point the interchange format's
  // positions (at_depth / user_top / assistant_top) and the per-turn
  // illustration reminder call for. A section would sit at the top of the
  // system prompt instead; adherence for per-turn direction is much better
  // close to the user's input.
  const loreOf = (context: AssembleContext) => {
    const svc = service()
    const agent = agentOf(context)
    const binding = agent ? svc.getBinding(String(agent.id)) : undefined
    const card = binding?.characterId ? svc.getCard(binding.characterId, binding.workspacePath) : undefined
    if (!card) return undefined
    return { card, groups: selectLore(card.book, recentText(agent)), userName: svc.settings.get().userName }
  }
  ctx.systemPrompt.context({
    name: 'roleplay:lore-depth',
    order: 100,
    text: (context) => {
      const lore = loreOf(context)
      return lore ? loreContext(lore.groups.depth, lore.card.name, lore.userName) : ''
    },
  })
  ctx.systemPrompt.context({
    name: 'roleplay:lore-user-top',
    order: 200,
    text: (context) => {
      const lore = loreOf(context)
      return lore ? loreContext(lore.groups.userTop, lore.card.name, lore.userName, '[补充设定]') : ''
    },
  })
  ctx.systemPrompt.context({
    name: 'roleplay:image',
    order: 220,
    text: (context) => {
      const svc = service()
      if (!svc.imageProviderStatus().available) return ''
      const settings = svc.settings.get()
      const agent = agentOf(context)
      const binding = agent ? svc.getBinding(String(agent.id)) : undefined
      const auto = binding?.autoImage ?? settings.autoImage
      if (!auto) return noAutoImageSection()
      const intent = detectImageIntent(lastUserText(agent))
      return autoImageSection(binding?.imageCount ?? settings.imageCount, settings.imageAggressiveness, intent)
    },
  })
  ctx.systemPrompt.context({
    name: 'roleplay:choice',
    order: 240,
    text: (context) => {
      const svc = service()
      const settings = svc.settings.get()
      const agent = agentOf(context)
      const binding = agent ? svc.getBinding(String(agent.id)) : undefined
      const choice = binding?.choiceMode ?? settings.choiceMode
      if (!choice) return ''
      return choiceModeSection(settings.choiceCount)
    },
  })
  ctx.systemPrompt.context({
    name: 'roleplay:lore-assistant-top',
    order: 300,
    text: (context) => {
      const lore = loreOf(context)
      return lore ? loreContext(lore.groups.assistantTop, lore.card.name, lore.userName, '[对下一条回复的指示]') : ''
    },
  })
  // Last of the contexts: the interchange format puts the card's
  // post-history instructions after everything else the model reads.
  ctx.systemPrompt.context({
    name: 'roleplay:card-post-history',
    order: 320,
    text: (context) => {
      const svc = service()
      const agent = agentOf(context)
      const binding = agent ? svc.getBinding(String(agent.id)) : undefined
      const card = binding?.characterId ? svc.getCard(binding.characterId, binding.workspacePath) : undefined
      if (!card) return ''
      return cardPostHistoryContext(card, svc.settings.get().userName)
    },
  })

  // One-shot stage direction: staged from the dock, appended to the NEXT
  // user message exactly as the interchange convention writes it
  // (`\n\n[系统指令: …]` on the message itself), then cleared — the durable
  // log carries the direction with the message it steered.
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const svc = service()
    const sessionId = String(payload.agent.id)
    const instruction = svc.getBinding(sessionId)?.pendingInstruction?.trim()
    if (!instruction) return decision
    let index = -1
    for (let i = decision.messages.length - 1; i >= 0; i--) {
      const source = decision.messages[i]?.source as { kind?: string } | undefined
      if (source?.kind === 'user') { index = i; break }
    }
    if (index < 0) return decision
    const original = decision.messages[index]!
    const content = [...original.content]
    const last = content[content.length - 1]
    const suffix = `\n\n[系统指令: ${instruction}]`
    if (last && (last as { type?: string }).type === 'text') {
      content[content.length - 1] = { ...(last as object), text: `${(last as { text?: string }).text ?? ''}${suffix}` } as typeof last
    } else {
      content.push({ type: 'text', text: suffix.trimStart() } as (typeof content)[number])
    }
    const messages = [...decision.messages]
    messages[index] = { ...original, content } as typeof original
    void svc.updateBinding(sessionId, { pendingInstruction: null }).catch(() => {})
    return { kind: 'enter' as const, messages }
  })

  // Choice-mode enforcement: with the toggle on, a turn that is about to stop
  // without having called ask_user_question is steered ONCE to produce the
  // options — the setting is a guarantee, not a suggestion the model may
  // forget. The steering runs one more step inside the same turn.
  //
  // The whole body is guarded: this hook runs INSIDE the turn, so anything it
  // throws fails the turn itself. A missing safety net is what turned the
  // removal of `session.events` in dsh 0.1.2 into "本轮运行失败 Cannot read
  // properties of undefined (reading 'length')" on every choice-mode reply.
  // Losing the steer degrades the guarantee to a prompt-level request; losing
  // the turn loses the user's reply.
  const steeredTurn = new Map<string, number>()
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    try {
      const svc = service()
      const binding = svc.getBinding(String(agent.id))
      if (!(binding?.choiceMode ?? svc.settings.get().choiceMode)) return
      const key = String(agent.id)
      if (steeredTurn.get(key) === turn) return
      if (calledAskUserQuestion(agent, turn)) return
      steeredTurn.set(key, turn)
      agent.steer(createUserMessage({
        content: [{
          type: 'text',
          text: '[系统指令: 本轮还没有给出行动选项。现在立即调用 ask_user_question 工具，给出本轮的下一步行动选项；不要重复或续写正文。]',
        }],
        source: { kind: ROLEPLAY_SOURCE },
      }))
    } catch (error) {
      ctx.logger.warn('choice-mode steering skipped: %s', error)
    }
  })

  registerImageTool(ctx, { background: true })
}

/**
 * Deny the host-plane global image tool for this preset's sessions, so a
 * role-play / forge model only ever sees its own scoped `generate_image`.
 *
 * `tools.restrict()` accepts only names that are KNOWN GLOBAL tools at call
 * time, and the global registration comes and goes with the settings toggle —
 * so the denial follows the registry through the `tools/change` event instead
 * of being registered once at preset load.
 */
function blockGlobalImageTool(ctx: Context): void {
  let lift: (() => void) | undefined
  let syncing = false
  const sync = () => {
    // restrict()/lift() mutate the layers and re-emit tools/change; the outer
    // call finishes the state change, so the nested notification is a no-op.
    if (syncing) return
    syncing = true
    try {
      const present = ctx.tools.get(GLOBAL_IMAGE_TOOL_NAME) !== undefined
      if (present && !lift) {
        lift = ctx.tools.restrict({ deny: [GLOBAL_IMAGE_TOOL_NAME] })
      } else if (!present && lift) {
        lift()
        lift = undefined
      }
    } catch (error) {
      ctx.logger.warn('failed to sync the %s denial: %s', GLOBAL_IMAGE_TOOL_NAME, error)
    } finally {
      syncing = false
    }
  }
  sync()
  ctx.on('tools/change', sync)
}

function registerForgeTools(ctx: Context): void {
  const positions = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'at_depth'] as const

  ctx.tools.register(defineTool({
    name: 'save_character_card',
    description:
      '创建或更新一张角色卡。传 card_id 表示更新已有卡片（未传的字段保持原值）；不传则新建。文本字段中指代用户写 {{user}}，指代角色写 {{char}}。只改世界书的个别条目时用 book_upsert / book_remove，不要用 book 重发整本。',
    parameters: {
      card_id: { type: 'string', description: 'Existing card id when updating' },
      name: { type: 'string', description: 'Character display name (required when creating)' },
      description: { type: 'string', description: 'Short reader-facing intro (~100 chars)' },
      personality: { type: 'string', description: 'Full persona definition' },
      scenario: { type: 'string', description: 'Opening scene / situation' },
      first_message: { type: 'string', description: 'Opening message (600-1000 chars)' },
      example_dialogs: { type: 'string', description: 'Optional example dialogue' },
      creator_notes: { type: 'string', description: 'Hashtag-style notes, e.g. "#奇幻 #校园"' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Topic tags' },
      avatar_image_id: { type: 'string', description: 'Image id from a previous generate_image call to use as the portrait' },
      avatar_upload_index: { type: 'number', description: '使用用户在本会话上传的第 N 张图片作为头像：按上传顺序 1 为第一张，-1 为最新一张；支持 PNG/JPEG/WebP/GIF。用户上传了图片并要求用作头像时用这个，与 avatar_image_id 二选一（同时给出时以本参数为准）' },
      regex_scripts: {
        type: 'array',
        description: 'Display-coloring regex rules applied to the character\'s replies',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', required: true, description: 'Short rule label' },
            find: { type: 'string', required: true, description: 'JS regex pattern; may use ONE capture group for the colored part' },
            replace: { type: 'string', required: true, description: 'Color carrier, e.g. <span style="color:#e5779a">$1</span> — only the color is applied' },
          },
        },
      },
      book: {
        type: 'array',
        description: '整本世界书：传入即替换全部条目，没列出的条目会被删除。只改个别条目时改用 book_upsert / book_remove。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Id of the existing entry this continues (from get_character_card); its unlisted settings are kept' },
            title: { type: 'string', required: true },
            content: { type: 'string', required: true },
            keys: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords; omit for constant entries' },
            constant: { type: 'boolean', description: 'Always inject, regardless of keywords' },
            position: { type: 'string', enum: [...positions], description: 'Injection position (default after_char)' },
            order: { type: 'number', description: 'Sort order within one position' },
          },
        },
      },
      book_upsert: {
        type: 'array',
        description: '世界书增量修改：只传要改或要加的条目，其余条目原样保留。用 id（或没有重名的 title）定位已有条目，只覆盖给出的字段；定位不到则作为新条目追加。不能与 book 同时使用。',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', description: 'Id of the entry to change; omit for a new entry' },
            title: { type: 'string', description: 'Locates the entry when no id is given; with an id, renames it. Required for a new entry' },
            content: { type: 'string' },
            keys: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords' },
            constant: { type: 'boolean', description: 'Always inject, regardless of keywords' },
            position: { type: 'string', enum: [...positions], description: 'Injection position' },
            order: { type: 'number', description: 'Sort order within one position' },
          },
        },
      },
      book_remove: {
        type: 'array',
        items: { type: 'string' },
        description: '世界书增量删除：要删除条目的 id 或标题（标题有重名时必须用 id）。不能与 book 同时使用。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          /** Entry count after a call that changed the lorebook. */
          book_entries: { type: 'number' },
          avatar_url: { type: 'string' },
          previous_avatar_image_id: { type: 'string' },
          // Where the card landed, for the client's card view: the store
          // lookup needs the workspace context (not part of the text the
          // model reads).
          workspace_path: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `角色卡「${value.name}」已保存（id: ${value.card_id}）。`
          + (value.book_entries !== undefined ? `世界书现有 ${value.book_entries} 条。` : '')
          + (value.previous_avatar_image_id
            ? `原头像已自动备份（image_id: ${value.previous_avatar_image_id}）；用户想换回原头像时，把它作为 avatar_image_id 再保存一次即可。`
            : '')
          + '用户可在「设置 → 角色扮演」中导出 PNG/JSON，或新建「角色扮演」会话使用它。',
      }],
      presentationMeta: (_args, value) => ({ ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const svc = ctx.roleplay
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const wsPath = agentId ? svc.getBinding(agentId)?.workspacePath : undefined
      const existing = args.card_id ? svc.getCard(args.card_id, wsPath) : undefined
      if (args.card_id && !existing) throw new Error(`卡片 ${args.card_id} 不存在`)
      const nextName = args.name ?? existing?.name
      if (!nextName) throw new Error('新建卡片必须提供 name')
      const regexScripts = args.regex_scripts?.map(script => ({
        name: script.name,
        find: script.find,
        replace: script.replace,
        flags: 'g',
        enabled: true,
        markdownOnly: true,
        promptOnly: false,
        placement: [2],
      }))
      const incremental = (args.book_upsert?.length ?? 0) > 0 || (args.book_remove?.length ?? 0) > 0
      if (args.book !== undefined && incremental) {
        throw new Error('book 与 book_upsert / book_remove 不能同时使用：整本替换用 book，改个别条目用后两者')
      }
      const storedBook = existing?.book ?? []
      const book = args.book !== undefined
        ? replaceBook(storedBook, args.book)
        : incremental ? editBook(storedBook, args.book_upsert ?? [], args.book_remove ?? []) : undefined
      let card = await svc.saveCard({
        ...existing,
        ...(args.card_id ? { id: args.card_id } : {}),
        name: nextName,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.personality !== undefined ? { personality: args.personality } : {}),
        ...(args.scenario !== undefined ? { scenario: args.scenario } : {}),
        ...(args.first_message !== undefined ? { firstMessage: args.first_message } : {}),
        ...(args.example_dialogs !== undefined ? { exampleDialogs: args.example_dialogs } : {}),
        ...(args.creator_notes !== undefined ? { creatorNotes: args.creator_notes } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(regexScripts !== undefined ? { regexScripts } : {}),
        ...(book !== undefined ? { book } : {}),
      }, { store: svc.settings.get().cardStore, wsPath })
      let previousAvatarImageId: string | undefined
      if (args.avatar_upload_index !== undefined || args.avatar_image_id) {
        previousAvatarImageId = await svc.archiveCurrentAvatar(card.id, wsPath)
      }
      if (args.avatar_upload_index !== undefined) {
        const png = await resolveUploadedImagePng(ctx, exec.agent, args.avatar_upload_index)
        card = await svc.setAvatar(card.id, png, wsPath)
      } else if (args.avatar_image_id) {
        card = await svc.setAvatarFromImage(card.id, args.avatar_image_id, wsPath)
      }
      const scope = svc.cardScope(card.id, wsPath)
      const avatarUrl = svc.avatarUrl(card, scope, wsPath)
      return {
        card_id: card.id,
        name: card.name,
        ...(book !== undefined ? { book_entries: card.book.length } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        ...(previousAvatarImageId ? { previous_avatar_image_id: previousAvatarImageId } : {}),
        ...(scope === 'workspace' && wsPath ? { workspace_path: wsPath } : {}),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'delete_character_card',
    description: '永久删除一张角色卡及其头像，不可恢复。仅在用户明确要求删除这张卡时调用；调用后由用户在界面上确认，未获确认不会删除。',
    parameters: {
      card_id: { type: 'string', required: true, description: 'Id of the card to delete' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `角色卡「${value.name}」已删除（id: ${value.card_id}）。` }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const svc = ctx.roleplay
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const wsPath = agentId ? svc.getBinding(agentId)?.workspacePath : undefined
      const card = svc.getCard(args.card_id, wsPath)
      if (!card) throw new Error(`卡片 ${args.card_id} 不存在`)
      // Card text is third-party content the model reads in this very mode, so
      // a deletion is never the model's call alone: each one goes through the
      // harness approval prompt. Every path that cannot put the question to
      // the user — no approval service, no agent to route it through, prompts
      // disabled for the session — ends in a refusal, not in a deletion.
      const approval = ctx.get('approval') as ApprovalLike | undefined
      if (!approval || !exec.agent) {
        throw new Error('当前环境无法向用户确认删除，未删除。请用户在「设置 → 角色扮演」中手动删除该卡。')
      }
      const outcome = await approval.request({
        agent: exec.agent,
        toolName: 'delete_character_card',
        callId: exec.callId,
        reason: `permanently delete the character card "${card.name}" (${card.id})`,
        displayReason: {
          en: `Permanently delete the character card “${card.name}”? This cannot be undone.`,
          zh: `永久删除角色卡「${card.name}」？该操作不可撤销。`,
        },
        signal: exec.signal,
      })
      if (outcome !== 'allowed-once') {
        throw new Error(outcome === 'rejected'
          ? `用户没有批准删除角色卡「${card.name}」，未删除。不要重试；如仍需删除，请用户在「设置 → 角色扮演」中操作。`
          : `删除角色卡「${card.name}」的确认未完成（${outcome}），未删除。`)
      }
      if (!await svc.deleteCard(card.id, wsPath)) throw new Error(`卡片 ${card.id} 不存在`)
      return { card_id: card.id, name: card.name }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_character_cards',
    description: '列出本地保存的全部角色卡。',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            name: { type: 'string', required: true },
            tags: { type: 'array', items: { type: 'string' }, required: true },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.length === 0 ? '本地还没有角色卡。' : value.map(card => `- ${card.name} (${card.id})`).join('\n'),
      }],
    },
    async execute(_args, exec) {
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const wsPath = agentId ? ctx.roleplay.getBinding(agentId)?.workspacePath : undefined
      return ctx.roleplay.listCards(wsPath).map(card => ({ id: card.id, name: card.name, tags: card.tags }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'get_character_card',
    description: '读取一张角色卡的完整内容。',
    parameters: {
      card_id: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const wsPath = agentId ? ctx.roleplay.getBinding(agentId)?.workspacePath : undefined
      const card = ctx.roleplay.getCard(args.card_id, wsPath)
      if (!card) throw new Error(`卡片 ${args.card_id} 不存在`)
      return card as unknown as JsonValue
    },
  }))
}

// applyMacros is re-exported for tests of the prompt pipeline.
export { applyMacros }
