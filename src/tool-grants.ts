/**
 * The role-play risk toggles (`allowFileTools` / `allowWebTools`).
 *
 * Preset definitions are static declarations since dsh 0.2, so a toggle can
 * no longer rewrite the role-play composition. The preset always mounts the
 * file and web tool rows (cordis.patch.yml); this module hides, per agent,
 * whatever the player has not granted, and follows the toggles live — the
 * catalog change reaches a running session from its next step.
 *
 * This runs on the HOST plane rather than inside the preset, for two reasons:
 *  - a new session's agent is created blank under the DEFAULT preset and only
 *    rebound to role-play when the client selects it, so its `agent/created`
 *    never reaches a listener scoped to the role-play preset; the selection is
 *    announced only by the unscoped `agent-preset/selected` event;
 *  - the first request's tool header is frozen when the turn opens, so the
 *    restriction has to be in place by selection time — a per-step hook inside
 *    the preset is one request too late.
 *
 * The restriction is issued from `agent.ctx`: a scope's restrictions filter
 * what it INHERITS, and the tool rows live in the preset layer, the agent's
 * parent.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SettingsStore } from './settings.ts'

/** The preset id the gating applies to (cordis.patch.yml `preset-roleplay`). */
const ROLEPLAY_PRESET = 'roleplay'

/** Model-facing tools each toggle unlocks, by the rows that provide them. */
const GRANTED_TOOLS = {
  // dsh-tool-fs + dsh-tool-fs-search
  allowFileTools: ['read', 'write', 'edit', 'read_image', 'glob', 'grep'],
  // dsh-tool-web (`web_fetch` stays off through the row config; listed in
  // case a user override turns it on)
  allowWebTools: ['web_search', 'web_fetch'],
} as const

type Toggle = keyof typeof GRANTED_TOOLS

/** The parts of the preset registry (`agentPresets`) this module reads. */
interface PresetRegistryLike {
  composedPreset(ctx: Context): string | undefined
}

/** The parts of the agent registry (`agents`) this module reads. */
interface AgentRegistryLike {
  get(id: string): Agent | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** dsh-agent-preset-registry: a blank session committed its preset. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}

/**
 * Install the gating.
 * @param ctx - the host row's (unscoped) context.
 * @param settings - the live role-play settings.
 */
export function gateRoleplayTools(ctx: Context, settings: SettingsStore): void {
  /** Restriction disposers per gated agent. */
  const gated = new Map<Agent, (() => void)[]>()

  const isRoleplay = (agent: Agent): boolean => {
    const presets = ctx.get('agentPresets') as PresetRegistryLike | undefined
    try {
      return presets?.composedPreset(agent.ctx) === ROLEPLAY_PRESET
    } catch {
      return false
    }
  }

  const lift = (agent: Agent) => {
    for (const dispose of gated.get(agent) ?? []) {
      try {
        dispose()
      } catch {
        // the agent scope may already be gone
      }
    }
    gated.delete(agent)
  }

  const gate = (agent: Agent) => {
    lift(agent)
    const current = settings.get()
    const disposers: (() => void)[] = []
    for (const [toggle, names] of Object.entries(GRANTED_TOOLS) as [Toggle, readonly string[]][]) {
      if (current[toggle]) continue
      for (const name of names) {
        // One restriction per name: restrict() rejects a name the scope does
        // not inherit, and one absent row must not leave the rest visible.
        try {
          disposers.push(agent.ctx.tools.restrict({ deny: [name] }))
        } catch {
          // not provided in this composition — nothing to hide
        }
      }
    }
    gated.set(agent, disposers)
  }

  const consider = (agent: Agent | undefined) => {
    if (agent !== undefined && !gated.has(agent) && isRoleplay(agent)) gate(agent)
  }

  // Resumed sessions: the agent is set up already bound to its preset.
  ctx.on('agent/created', ({ agent }) => {
    consider(agent)
    return undefined
  })
  // New sessions: the client selects the preset before the first turn opens.
  ctx.on('agent-preset/selected', (sessionId, agentPreset) => {
    if (agentPreset !== ROLEPLAY_PRESET) return
    const agents = ctx.get('agents') as AgentRegistryLike | undefined
    consider(agents?.get(sessionId))
  })
  // Safety net for any binding path neither event covers (e.g. a preset
  // selected by another surface); a no-op for agents already gated.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    consider(agent)
    return next()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    lift(agent)
  })

  ctx.effect(() => settings.watch(() => {
    for (const agent of [...gated.keys()]) gate(agent)
  }), 'roleplay.watch(tool grants)')
  ctx.effect(() => () => {
    for (const agent of [...gated.keys()]) lift(agent)
  }, 'roleplay.gateRoleplayTools()')
}
