/**
 * Import/export between the local card model and the community character-card
 * interchange formats (spec V1 flat objects, V2/V3 `data`-wrapped objects,
 * PNG-embedded payloads under the `chara` / `ccv3` keywords).
 */
import { randomUUID } from 'node:crypto'
import { CharacterCard, LoreEntry, RegexScript, type LorePosition } from './types.ts'
import { isPng, readTextChunks, writeTextChunks } from './png.ts'

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Map the interchange formats' position vocabulary onto the local one. */
function normalizePosition(value: unknown): LorePosition {
  if (typeof value === 'number') {
    const byNumber: Record<number, LorePosition> = {
      0: 'before_char',
      1: 'after_char',
      2: 'system_top',
      3: 'system_top',
      4: 'at_depth',
    }
    return byNumber[value] ?? 'at_depth'
  }
  const text = asString(value)
  if (
    text === 'before_char' || text === 'before_character' || text === 'character_top' ||
    text === 'before_examples' || text === 'example_top'
  ) return 'before_char'
  if (
    text === 'after_char' || text === 'after_character' || text === 'character_bottom' ||
    text === 'after_examples' || text === 'example_bottom'
  ) return 'after_char'
  if (text === 'system_top' || text === 'an_top' || text === 'an_bottom' || text === 'author_note' || text === 'global_note') return 'system_top'
  if (text === 'user_top') return 'user_top'
  if (text === 'assistant_top') return 'assistant_top'
  if (text === 'at_depth') return 'at_depth'
  return 'after_char'
}

function normalizeKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asString).filter(Boolean)
  const text = asString(value)
  if (!text) return []
  return text.split(/[,，]/).map(part => part.trim()).filter(Boolean)
}

function normalizeLoreEntry(raw: unknown): LoreEntry | undefined {
  const entry = asRecord(raw)
  if (!entry) return undefined
  const disabled = entry.disable === true || entry.disabled === true || entry.enabled === false
  return LoreEntry.parse({
    id: randomUUID(),
    title: asString(entry.comment) || asString(entry.title) || asString(entry.name),
    content: asString(entry.content),
    keys: normalizeKeys(entry.keys ?? entry.key),
    useRegex: entry.useRegex === true || entry.use_regex === true,
    constant: entry.constant === true,
    position: normalizePosition(entry.position),
    order: typeof entry.order === 'number' ? entry.order
      : typeof entry.insertion_order === 'number' ? entry.insertion_order : 100,
    depth: typeof entry.depth === 'number' && entry.depth >= 0 ? Math.floor(entry.depth) : 4,
    scanDepth: typeof entry.scanDepth === 'number' && entry.scanDepth >= 0 ? Math.floor(entry.scanDepth)
      : typeof entry.scan_depth === 'number' && entry.scan_depth >= 0 ? Math.floor(entry.scan_depth) : 0,
    probability: typeof entry.probability === 'number' ? Math.min(100, Math.max(0, entry.probability)) : 100,
    enabled: !disabled,
  })
}

function normalizeBook(raw: unknown): LoreEntry[] {
  const book = asRecord(raw)
  const entries = Array.isArray(raw) ? raw
    : book && Array.isArray(book.entries) ? book.entries
      : book && asRecord(book.entries) ? Object.values(asRecord(book.entries)!)
        : []
  return entries.map(normalizeLoreEntry).filter((entry): entry is LoreEntry => entry !== undefined)
}

/** Normalize one interchange regex script (field aliases vary across tools). */
function normalizeRegexScript(raw: unknown): RegexScript | undefined {
  const script = asRecord(raw)
  if (!script) return undefined
  const find = asString(script.findRegex) || asString(script.regex) || asString(script.find)
  if (!find) return undefined
  const disabled = script.disabled === true || script.enabled === false
  const placement = Array.isArray(script.placement)
    ? script.placement.filter((value): value is number => typeof value === 'number')
    : []
  return RegexScript.parse({
    name: asString(script.scriptName) || asString(script.name),
    find,
    replace: typeof script.replaceString === 'string' ? script.replaceString
      : typeof script.replacement === 'string' ? script.replacement
        : typeof script.replace === 'string' ? script.replace : '',
    flags: asString(script.regexFlags) || asString(script.flags) || 'g',
    enabled: !disabled,
    markdownOnly: script.markdownOnly === true,
    promptOnly: script.promptOnly === true,
    // An absent/empty placement means "everywhere" in the wild.
    placement: placement.length > 0 ? placement : [1, 2],
  })
}

function normalizeRegexScripts(raw: unknown): RegexScript[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeRegexScript).filter((script): script is RegexScript => script !== undefined)
}

/** Parse one interchange JSON payload into a fresh local card (new id). */
export function cardFromInterchange(raw: unknown): CharacterCard {
  const root = asRecord(raw)
  if (!root) throw new Error('character payload is not an object')
  const data = asRecord(root.data) ?? root
  const name = asString(data.name) || asString(data.char_name)
  if (!name) throw new Error('character payload has no name')
  const now = Date.now()
  return CharacterCard.parse({
    id: randomUUID(),
    name,
    description: asString(data.description) || asString(data.char_persona),
    personality: asString(data.personality),
    scenario: asString(data.scenario),
    firstMessage: asString(data.first_mes) || asString(data.first_message) || asString(data.greeting),
    exampleDialogs: asString(data.mes_example) || asString(data.example_dialogs),
    creatorNotes: asString(data.creator_notes) || asString(data.creatorcomment) || asString(data.creator_comment),
    tags: Array.isArray(data.tags) ? data.tags.map(asString).filter(Boolean) : [],
    book: normalizeBook(data.character_book ?? root.character_book),
    regexScripts: normalizeRegexScripts(asRecord(data.extensions)?.regex_scripts),
    favorite: false,
    createdAt: now,
    updatedAt: now,
  })
}

/** Extract the embedded card payload from a PNG, when one exists. */
export function cardFromPng(bytes: Buffer): CharacterCard | undefined {
  if (!isPng(bytes)) return undefined
  const texts = readTextChunks(bytes)
  const payload = texts.get('chara') ?? texts.get('ccv3')
  if (!payload) return undefined
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {
    try {
      json = JSON.parse(payload)
    } catch {
      return undefined
    }
  }
  return cardFromInterchange(json)
}

function loreEntryToInterchange(entry: LoreEntry, index: number): Record<string, unknown> {
  return {
    id: index,
    comment: entry.title,
    content: entry.content,
    keys: entry.keys,
    use_regex: entry.useRegex,
    constant: entry.constant,
    position: entry.position,
    insertion_order: entry.order,
    depth: entry.depth,
    ...(entry.scanDepth > 0 ? { scan_depth: entry.scanDepth } : {}),
    probability: entry.probability,
    enabled: entry.enabled,
  }
}

/** Render one card as a spec-V2 interchange object. */
export function cardToInterchange(card: CharacterCard): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.firstMessage,
    mes_example: card.exampleDialogs,
    creator_notes: card.creatorNotes,
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: card.tags,
    creator: '',
    character_version: '',
    extensions: card.regexScripts.length > 0
      ? {
          regex_scripts: card.regexScripts.map(script => ({
            scriptName: script.name,
            findRegex: script.find,
            replaceString: script.replace,
            flags: script.flags,
            disabled: !script.enabled,
            markdownOnly: script.markdownOnly,
            promptOnly: script.promptOnly,
            placement: script.placement,
          })),
        }
      : {},
  }
  if (card.book.length > 0) {
    data.character_book = { entries: card.book.map(loreEntryToInterchange) }
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data }
}

/**
 * Embed the card into a portrait PNG under both the V2 (`chara`) and V3
 * (`ccv3`) keywords so either flavor of reader can open the export.
 */
export function cardToPng(card: CharacterCard, portrait: Buffer): Buffer {
  const v2 = cardToInterchange(card)
  const v3 = { ...v2, spec: 'chara_card_v3', spec_version: '3.0' }
  return writeTextChunks(portrait, {
    chara: Buffer.from(JSON.stringify(v2), 'utf8').toString('base64'),
    ccv3: Buffer.from(JSON.stringify(v3), 'utf8').toString('base64'),
  })
}
