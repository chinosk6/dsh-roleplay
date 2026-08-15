/**
 * Browser half of the dsh-roleplay bundle. Registers:
 *  - the「角色扮演」settings page (settings.section, locale-aware nav label)
 *  - the role-play dock above the composer (conversation.input.dock)
 *  - keyed renderers for the generate_image / save_character_card tool calls
 *  - a role-play addition to the native assistant action strip
 *    (conversation.chat.assistant-actions: regenerate / re-roll images)
 *  - a keyed shadow of the `user` chat node that DELEGATES to the shadowed
 *    native renderer outside role-play sessions (pixel-identical there) and
 *    adds in-place editing inside them (see user-node.tsx)
 *
 * Deliberately NO assistant-step shadow: keyed-slot shadowing is
 * process-global, so an assistant takeover would leak into non-RP sessions
 * and replace the native Think UI. Role-play sessions get their bubble
 * layout through scoped CSS instead — the dock marks the page with
 * `data-rp-active` while a role-play session is current (see dock.tsx), and
 * styles.ts targets `[data-chat-flow-kind="assistant-step"]` under that flag
 * only. Native renderers (including the Think row) stay untouched everywhere.
 *
 * Locale: dictionaries are registered with the dsh locale service and the
 * plugin's own i18n layer mirrors the active locale, so every component
 * re-renders with fresh copy when the UI language switches.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { injectCss } from './styles.ts'
import { RoleplayDock } from './dock.tsx'
import { RoleplaySettingsSection } from './settings-section.tsx'
import { GenerateImageView, SaveCardView } from './toolviews.tsx'
import { RoleplayAssistantActions } from './assistant-actions.tsx'
import { RoleplayUserNode } from './user-node.tsx'
import { CardEditor } from './card-editor.tsx'
import { wireRuntime } from './runtime.ts'
import { zh, en, LOCALE_NS, setLocale } from './i18n.ts'

export const name = 'roleplay-client'
export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: ClientContext): void {
  injectCss()
  wireRuntime({
    sessions: ctx.sessions as never,
    workspaces: ctx.workspaces as never,
    slots: ctx.slots as never,
  })

  // ── locale wiring ──
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'dsh-roleplay: dictionaries')
  const t = ctx.locale.bind(LOCALE_NS)
  setLocale(ctx.locale.getLocale().active)
  ctx.effect(
    () => ctx.locale.subscribe(() => { setLocale(ctx.locale.getLocale().active) }),
    'dsh-roleplay: locale mirror',
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'roleplay', order: 40, label: () => t('rp.settings.title'), locale: LOCALE_NS },
      RoleplaySettingsSection as never,
    ))

  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'roleplay-dock', order: 10 },
      RoleplayDock as never,
    ))

  ctx.slots.inject('tool.call.toolview', () => [
    ctx.slots.register({ name: 'tool.call.toolview', key: 'generate_image' }, GenerateImageView as never),
    ctx.slots.register({ name: 'tool.call.toolview', key: 'save_character_card' }, SaveCardView as never),
  ])

  // Role-play actions in the native assistant action strip (list slot —
  // additive, renders nothing outside role-play sessions).
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register(
      { name: 'conversation.chat.assistant-actions', id: 'roleplay-actions', order: 10 },
      RoleplayAssistantActions as never,
    ))

  // Keyed shadow of the `user` chat node. Outside role-play sessions the
  // component looks up and renders the shadowed NATIVE entry verbatim, so
  // this global takeover is visually inert everywhere except role-play.
  // `locale: 'conversation'` binds the conversation namespace's `t` seat —
  // the delegated native renderer reads its own copy through it.
  ctx.slots.inject('conversation.chat.node', () =>
    ctx.slots.register(
      { name: 'conversation.chat.node', key: 'user', priority: -1, locale: 'conversation' },
      RoleplayUserNode as never,
    ))
}

export { CardEditor }
