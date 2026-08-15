/**
 * Session-plane plugin, mounted only through the two agent presets this
 * bundle materializes. It contributes the mode persona (shadowing the global
 * deployment persona for its preset's sessions), the per-session character
 * context, and the model-facing tools.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { PERSONA_ORDER, PERSONA_SECTION, type AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import {
  applyMacros,
  autoImageSection,
  characterSection,
  choiceModeSection,
  detectImageIntent,
  escapeBraces,
  forgeBoundCardSection,
  forgePersona,
  loreContext,
  noAutoImageSection,
  roleplayStandingRules,
  selectLore,
  unboundHint,
} from './prompts.ts'
import type {} from './service.ts'

export const name = 'roleplay-agent'
export const inject = ['roleplay', 'systemPrompt', 'tools']

export interface Config {
  mode: 'roleplay' | 'forge'
}

export const Config: z<Config> = z.object({
  mode: z.union(['roleplay', 'forge']).default('roleplay'),
})

/** Concatenated text of the last few derived messages, for lore keyword scans. */
function recentText(agent: Agent | undefined): string {
  if (!agent) return ''
  try {
    const texts: string[] = []
    for (const message of agent.session.deriveMessages().slice(-6)) {
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

/** Text of the latest user-role message, for image-intent detection. */
function lastUserText(agent: Agent | undefined): string {
  if (!agent) return ''
  try {
    const messages = agent.session.deriveMessages()
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as { role?: string; content?: unknown } | undefined
      if (message?.role !== 'user') continue
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

export function apply(ctx: Context, config: Config): void {
  const service = () => ctx.roleplay

  if (config.mode === 'forge') {
    ctx.systemPrompt.variable('user_macro', () => '{{user}}')
    ctx.systemPrompt.variable('char_macro', () => '{{char}}')
    ctx.systemPrompt.section({
      name: PERSONA_SECTION,
      order: PERSONA_ORDER,
      text: () => forgePersona(),
    })
    ctx.systemPrompt.section({
      name: 'roleplay:forge-card',
      order: 10,
      text: (context) => {
        const svc = service()
        const agent = agentOf(context)
        const binding = agent ? svc.getBinding(String(agent.id)) : undefined
        const card = binding?.characterId ? svc.getCard(binding.characterId) : undefined
        if (!card) return ''
        return escapeBraces(forgeBoundCardSection(card))
      },
    })
    registerForgeTools(ctx)
    registerImageTool(ctx, false)
    return
  }

  // ── role-play mode ──
  ctx.systemPrompt.section({
    name: PERSONA_SECTION,
    order: PERSONA_ORDER,
    text: (context) => {
      const svc = service()
      const settings = svc.settings.get()
      const agent = agentOf(context)
      const binding = agent ? svc.getBinding(String(agent.id)) : undefined
      const card = binding?.characterId ? svc.getCard(binding.characterId) : undefined
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
    const card = binding?.characterId ? svc.getCard(binding.characterId) : undefined
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
  const steeredTurn = new Map<string, number>()
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const svc = service()
    const binding = svc.getBinding(String(agent.id))
    if (!(binding?.choiceMode ?? svc.settings.get().choiceMode)) return
    const key = String(agent.id)
    if (steeredTurn.get(key) === turn) return
    const events = agent.session.events
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (!event) continue
      if (event.type === 'turn/start' && event.data.turn === turn) break
      if (event.type === 'tool/call' && event.data.turn === turn && event.data.name === 'ask_user_question') return
    }
    steeredTurn.set(key, turn)
    agent.steer(createUserMessage({
      content: [{
        type: 'text',
        text: '[系统指令: 本轮还没有给出行动选项。现在立即调用 ask_user_question 工具，给出本轮的下一步行动选项；不要重复或续写正文。]',
      }],
      source: { kind: 'plugin', plugin: 'dsh-roleplay' },
    }))
  })

  registerImageTool(ctx, true)
}

/**
 * @param background - role-play mode: the tool returns as soon as the tasks
 * are queued so the story keeps streaming while images render (the client
 * polls readiness). Forge mode keeps `false`: an avatar id must exist on disk
 * before save_character_card copies it.
 */
function registerImageTool(ctx: Context, background: boolean): void {
  ctx.tools.register(defineTool({
    name: 'generate_image',
    description:
      '为当前场景生成插图。prompt 使用英文 danbooru 风格 tag（逗号分隔）：主体身份、外貌、表情姿势、动作、服装、环境光照、构图镜头。成人画面带 nsfw；用户在场用 pov、不要画用户的脸。生成的图片会直接展示给用户。',
    parameters: {
      prompt: { type: 'string', required: true, description: 'English danbooru-style tags, comma separated' },
      count: { type: 'number', description: 'Number of images (1-6); omit to use the configured default. Pass 1 when interleaving several illustrations between paragraphs' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                url: { type: 'string', required: true },
                width: { type: 'number' },
                height: { type: 'number' },
              },
            },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: background
          ? `已安排 ${value.images.length} 张插图在后台生成，完成后会自动展示给用户。请立即继续正文剧情：不要等待生成、不要提及生成过程、不要在回复中粘贴图片链接。`
          : `已生成 ${value.images.length} 张插图并直接展示给用户。请继续正文剧情，不要在回复中粘贴图片链接。`,
      }],
      presentationMeta: (_args, value) => ({ images: value.images }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const agentId = exec.agent ? String(exec.agent.id) : undefined
      const binding = agentId ? ctx.roleplay.getBinding(agentId) : undefined
      const count = args.count ?? binding?.imageCount ?? ctx.roleplay.settings.get().imageCount
      const images = await ctx.roleplay.generateImages(
        args.prompt,
        count,
        background ? undefined : exec.signal,
        agentId,
        !background,
      )
      return { images }
    },
  }))
}

function registerForgeTools(ctx: Context): void {
  const positions = ['system_top', 'before_char', 'after_char', 'user_top', 'assistant_top', 'at_depth'] as const

  ctx.tools.register(defineTool({
    name: 'save_character_card',
    description:
      '创建或更新一张角色卡。传 card_id 表示更新已有卡片（未传的字段保持原值）；不传则新建。文本字段中指代用户写 {{user}}，指代角色写 {{char}}。',
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
      book: {
        type: 'array',
        description: 'Lorebook entries',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true },
            content: { type: 'string', required: true },
            keys: { type: 'array', items: { type: 'string' }, description: 'Trigger keywords; omit for constant entries' },
            constant: { type: 'boolean', description: 'Always inject, regardless of keywords' },
            position: { type: 'string', enum: [...positions], description: 'Injection position (default after_char)' },
            order: { type: 'number', description: 'Sort order within one position' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          card_id: { type: 'string', required: true },
          name: { type: 'string', required: true },
          avatar_url: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `角色卡「${value.name}」已保存（id: ${value.card_id}）。用户可在「设置 → 角色扮演」中导出 PNG/JSON，或新建「角色扮演」会话使用它。`,
      }],
      presentationMeta: (_args, value) => ({ ...value }),
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const svc = ctx.roleplay
      const existing = args.card_id ? svc.getCard(args.card_id) : undefined
      if (args.card_id && !existing) throw new Error(`卡片 ${args.card_id} 不存在`)
      const nextName = args.name ?? existing?.name
      if (!nextName) throw new Error('新建卡片必须提供 name')
      const book = args.book?.map((entry, index) => ({
        id: `lore-${index}`,
        title: entry.title,
        content: entry.content,
        keys: entry.keys ?? [],
        constant: entry.constant ?? (entry.keys === undefined || entry.keys.length === 0),
        position: (positions as readonly string[]).includes(entry.position ?? '') ? entry.position : 'after_char',
        order: entry.order ?? 100,
      }))
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
        ...(book !== undefined ? { book } : {}),
      })
      if (args.avatar_image_id) card = await svc.setAvatarFromImage(card.id, args.avatar_image_id)
      const avatarUrl = svc.avatarUrl(card)
      return { card_id: card.id, name: card.name, ...(avatarUrl ? { avatar_url: avatarUrl } : {}) }
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
    async execute() {
      return ctx.roleplay.listCards().map(card => ({ id: card.id, name: card.name, tags: card.tags }))
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
    async execute(args) {
      const card = ctx.roleplay.getCard(args.card_id)
      if (!card) throw new Error(`卡片 ${args.card_id} 不存在`)
      return card as unknown as import('@deepseek-ai/dsh-tools').JsonValue
    },
  }))
}

// applyMacros is re-exported for tests of the prompt pipeline.
export { applyMacros }
