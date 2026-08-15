/**
 * Role-play prose colorizer.
 *
 * Rules come from two places: the built-in dialogue/thought pair, and the
 * bound card's regex scripts (their display-coloring subset — see
 * `compileCardRules`). Two delivery mechanisms for the same rules:
 * - `colorizeProse()` renders spans — for content this plugin draws itself
 *   (the opening-message bubble), where the DOM is ours.
 * - `startProseHighlighter()` paints NATIVE assistant messages via the CSS
 *   Custom Highlight API: ranges + `::highlight()` rules color text without
 *   touching the DOM tree at all, so the stock renderers (markdown, Think
 *   rows) never see a foreign node — React reconciliation stays untouched.
 *   Only active while a role-play session is mounted.
 */
import type { ReactNode } from 'react'
import type { RegexScriptValue } from './api.ts'

/** Spoken dialogue: 『…』 / 「…」 / “…”. */
const SAY_RE = /『[^『』\n]*』|「[^「」\n]*」|“[^“”\n]*”/g
/** Inner thoughts: full-width （…） (half-width stays plain — too common in code/links). */
const THINK_RE = /（[^（）\n]*）/g

/** Replace the card macros with live names (client-side mirror of the host's applyMacros). */
export function replaceMacros(text: string, charName: string, userName: string): string {
  return text.replaceAll(/\{\{\s*char\s*\}\}/gi, charName).replaceAll(/\{\{\s*user\s*\}\}/gi, userName)
}

/** One compiled card rule: color whatever the regex (or its group 1) matches. */
export interface CardColorRule {
  regex: RegExp
  color: string
  /** 0 = whole match; 1 = capture group 1 (when the replacement targets $1). */
  group: number
}

// Matches `color: x` and `color="x"` (font tags), but not `background-color:`.
const COLOR_RE = /(?<![a-zA-Z-])color\s*[:=]\s*['"]?(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)|[a-zA-Z]+)/
/** CSS color keywords that carry no usable hue. */
const NON_COLORS = new Set(['inherit', 'initial', 'unset', 'revert', 'transparent', 'currentcolor', 'none', 'var'])
/**
 * Wrapper-script detector probe: layout scripts wrap the ENTIRE message
 * (e.g. `^([\s\S]+)$` panel builders) and would tint all text with one color;
 * a rule that swallows this whole mixed sample is one of those, not a
 * fragment-level coloring rule.
 */
const WRAPPER_PROBE = '第一段叙述文字。\n『对白』（心声）与其它关键词。'

/**
 * Compile a card's regex scripts down to the display-coloring subset this
 * plugin can honor: enabled, not prompt-only, assistant placement, and an
 * inline `color:` in the replacement to borrow. Full HTML rewriting is out of
 * scope — native message DOM is never modified. Invalid patterns are skipped.
 */
export function compileCardRules(scripts: RegexScriptValue[]): CardColorRule[] {
  const rules: CardColorRule[] = []
  for (const script of scripts) {
    if (!script.enabled || script.promptOnly) continue
    if (script.placement.length > 0 && !script.placement.includes(2)) continue
    const colorMatch = COLOR_RE.exec(script.replace)
    if (!colorMatch) continue
    const color = colorMatch[1]!.replace(/[{};]/g, '')
    if (NON_COLORS.has(color.toLowerCase())) continue

    let pattern = script.find
    let flags = script.flags || 'g'
    // /pattern/flags form
    if (pattern.startsWith('/') && pattern.lastIndexOf('/') > 0) {
      const lastSlash = pattern.lastIndexOf('/')
      const tail = pattern.slice(lastSlash + 1)
      if (/^[dgimsuy]*$/.test(tail)) {
        flags = tail || flags
        pattern = pattern.slice(1, lastSlash)
      }
    }
    // Inline modifiers common in interchange scripts
    for (const [inline, flag] of [['(?s)', 's'], ['(?i)', 'i'], ['(?m)', 'm']] as const) {
      if (pattern.includes(inline)) {
        pattern = pattern.replaceAll(inline, '')
        if (!flags.includes(flag)) flags += flag
      }
    }
    if (!flags.includes('g')) flags += 'g'
    const group = /\$1/.test(script.replace) && /\((?!\?)/.test(pattern) ? 1 : 0
    if (group > 0 && !flags.includes('d')) flags += 'd'
    try {
      const regex = new RegExp(pattern, flags)
      const probeMatch = regex.exec(WRAPPER_PROBE)
      regex.lastIndex = 0
      // Whole-message wrapper scripts are layout, not coloring — skip them.
      if (probeMatch && probeMatch[0] === WRAPPER_PROBE) continue
      rules.push({ regex, color, group })
    } catch {
      // invalid pattern/flags: the script is ignored rather than fatal
    }
  }
  return rules
}

interface Segment {
  start: number
  end: number
  className?: string
  color?: string
}

function matchSpan(match: RegExpMatchArray, group: number): [number, number] | undefined {
  const start = match.index ?? 0
  if (group === 0) return [start, start + match[0].length]
  const indices = (match as RegExpMatchArray & { indices?: ([number, number] | undefined)[] }).indices
  const span = indices?.[group]
  if (span) return span
  // No indices support: fall back to the whole match.
  return [start, start + match[0].length]
}

function segmentsOf(text: string, rules: readonly CardColorRule[]): Segment[] {
  const segments: Segment[] = []
  for (const match of text.matchAll(SAY_RE)) {
    segments.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, className: 'rp-say' })
  }
  for (const match of text.matchAll(THINK_RE)) {
    segments.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length, className: 'rp-think' })
  }
  for (const rule of rules) {
    for (const match of text.matchAll(rule.regex)) {
      const span = matchSpan(match, rule.group)
      if (span && span[1] > span[0]) segments.push({ start: span[0], end: span[1], color: rule.color })
    }
  }
  return segments.sort((a, b) => a.start - b.start)
}

/** Render prose with coloring spans (for plugin-owned DOM); overlaps keep the earlier match. */
export function colorizeProse(text: string, rules: readonly CardColorRule[] = []): ReactNode[] {
  const nodes: ReactNode[] = []
  let cursor = 0
  for (const segment of segmentsOf(text, rules)) {
    if (segment.start < cursor) continue
    if (segment.start > cursor) nodes.push(text.slice(cursor, segment.start))
    nodes.push(
      <span
        key={`${segment.start}-${segment.end}`}
        {...(segment.className ? { className: segment.className } : {})}
        {...(segment.color ? { style: { color: segment.color } } : {})}
      >
        {text.slice(segment.start, segment.end)}
      </span>,
    )
    cursor = segment.end
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return nodes
}

/** Normalize any CSS color to #rrggbb for `<input type="color">` (canvas trick). */
export function toHexColor(color: string): string | undefined {
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.fillStyle = '#000'
    ctx.fillStyle = color
    const normalized = ctx.fillStyle
    return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized : undefined
  } catch {
    return undefined
  }
}

/**
 * Rewrite the (first) color value inside a replacement template; a template
 * without one gets wrapped in a fresh color-carrying span.
 */
export function withColorValue(template: string, hex: string): string {
  const match = COLOR_RE.exec(template)
  if (!match) return `<span style="color:${hex}">${template || '$1'}</span>`
  const start = match.index + match[0].length - match[1]!.length
  return `${template.slice(0, start)}${hex}${template.slice(start + match[1]!.length)}`
}

interface HighlightLike {
  add(range: Range): void
  clear(): void
}

/**
 * Start painting native assistant messages; returns the stop function.
 * Card rules get one highlight name each (`rp-card-N`) with a matching
 * `::highlight` style injected for the run's lifetime. Feature-detects the
 * Highlight API and degrades to a no-op without it.
 */
export function startProseHighlighter(cardRules: readonly CardColorRule[] = []): () => void {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const HighlightCtor = (globalThis as unknown as { Highlight?: new () => HighlightLike }).Highlight
  if (!registry || !HighlightCtor) return () => {}

  const say = new HighlightCtor()
  const think = new HighlightCtor()
  registry.set('rp-say', say as unknown)
  registry.set('rp-think', think as unknown)

  const cardHighlights = cardRules.map((rule, index) => {
    const highlight = new HighlightCtor()
    registry.set(`rp-card-${index}`, highlight as unknown)
    return highlight
  })
  let style: HTMLStyleElement | undefined
  if (cardRules.length > 0) {
    style = document.createElement('style')
    style.textContent = cardRules
      .map((rule, index) => `::highlight(rp-card-${index}){color:${rule.color}}`)
      .join('\n')
    document.head.appendChild(style)
  }

  const collect = (node: Text, text: string) => {
    for (const match of text.matchAll(SAY_RE)) {
      const range = new Range()
      range.setStart(node, match.index ?? 0)
      range.setEnd(node, (match.index ?? 0) + match[0].length)
      say.add(range)
    }
    for (const match of text.matchAll(THINK_RE)) {
      const range = new Range()
      range.setStart(node, match.index ?? 0)
      range.setEnd(node, (match.index ?? 0) + match[0].length)
      think.add(range)
    }
    for (let index = 0; index < cardRules.length; index++) {
      const rule = cardRules[index]!
      for (const match of text.matchAll(rule.regex)) {
        const span = matchSpan(match, rule.group)
        if (!span || span[1] <= span[0] || span[1] > text.length) continue
        const range = new Range()
        range.setStart(node, span[0])
        range.setEnd(node, span[1])
        cardHighlights[index]!.add(range)
      }
    }
  }

  const rescan = () => {
    say.clear()
    think.clear()
    for (const highlight of cardHighlights) highlight.clear()
    for (const step of document.querySelectorAll('[data-chat-flow-kind="assistant-step"]')) {
      const walker = document.createTreeWalker(step, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue
        if (!text || text.length < 2) continue
        collect(node as Text, text)
      }
    }
  }

  // Streaming rewrites text nodes constantly; a debounced full rescan keeps
  // ranges valid at a negligible cost (linear over visible message text).
  let timer: number | undefined
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(rescan, 180)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, characterData: true, subtree: true })
  schedule()

  return () => {
    observer.disconnect()
    if (timer !== undefined) window.clearTimeout(timer)
    registry.delete('rp-say')
    registry.delete('rp-think')
    cardHighlights.forEach((_, index) => registry.delete(`rp-card-${index}`))
    style?.remove()
  }
}
