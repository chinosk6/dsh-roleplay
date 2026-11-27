/**
 * Lorebook edits requested through the forge tools, applied to a card's
 * stored book.
 *
 * The tools expose only part of a lore entry (title, content, keys, constant,
 * position, order). The rest — regex keys, depth, scan depth, probability,
 * the enabled flag — exists on imported cards and is editable in the card
 * editor, so every edit here starts from the stored entry and overlays what
 * the model actually sent.
 */
import { randomUUID } from 'node:crypto'
import { LORE_POSITIONS, LoreEntry } from './types.ts'

/** The lore fields a forge tool call may set. */
export interface LoreEntryPatch {
  /** Id of the stored entry this refers to. */
  id?: string | undefined
  title?: string | undefined
  content?: string | undefined
  keys?: string[] | undefined
  constant?: boolean | undefined
  position?: string | undefined
  order?: number | undefined
}

function label(entry: LoreEntry): string {
  return `${entry.title || '（无标题）'} (id: ${entry.id})`
}

/** Stored entries carrying this exact, non-empty title. */
function titled(book: readonly LoreEntry[], title: string | undefined): LoreEntry[] {
  return title ? book.filter(entry => entry.title === title) : []
}

/** Overlay a patch on a stored entry, or build a new entry from it. */
function merge(prev: LoreEntry | undefined, patch: LoreEntryPatch): LoreEntry {
  const keys = patch.keys ?? prev?.keys ?? []
  const position = (LORE_POSITIONS as readonly string[]).includes(patch.position ?? '')
    ? patch.position
    : prev?.position ?? 'after_char'
  return LoreEntry.parse({
    ...prev,
    id: prev?.id ?? randomUUID(),
    title: patch.title ?? prev?.title ?? '',
    content: patch.content ?? prev?.content ?? '',
    keys,
    // A new entry without keywords could never fire unless it is constant.
    constant: patch.constant ?? prev?.constant ?? keys.length === 0,
    position,
    order: patch.order !== undefined ? Math.round(patch.order) : prev?.order ?? 100,
  })
}

/**
 * Replace the whole book with `entries`, in their order.
 *
 * An incoming entry that names a stored one — by id, or by a title exactly
 * one stored entry has — continues it: the id and every field the entry does
 * not set are kept. Anything else is a new entry. Each stored entry is
 * continued at most once.
 */
export function replaceBook(stored: readonly LoreEntry[], entries: readonly LoreEntryPatch[]): LoreEntry[] {
  const taken = new Set<LoreEntry>()
  return entries.map(entry => {
    const byId = entry.id ? stored.find(candidate => candidate.id === entry.id) : undefined
    const sameTitle = titled(stored, entry.title)
    const prev = byId ?? (sameTitle.length === 1 ? sameTitle[0] : undefined)
    if (prev === undefined || taken.has(prev)) return merge(undefined, entry)
    taken.add(prev)
    return merge(prev, entry)
  })
}

/**
 * Apply incremental edits and return the new book; untouched entries keep
 * their position in the list.
 * @param upserts - each one updates the stored entry it names (by id, or by a
 *   title exactly one entry has) or, naming none, is appended as a new entry.
 * @param removals - ids or titles of entries to drop, applied after the upserts.
 * @throws when an id matches nothing, a title matches several entries, or a
 *   new entry has no title — the caller saves nothing in that case.
 */
export function editBook(
  stored: readonly LoreEntry[],
  upserts: readonly LoreEntryPatch[],
  removals: readonly string[],
): LoreEntry[] {
  let book = [...stored]
  for (const patch of upserts) {
    let prev: LoreEntry | undefined
    if (patch.id) {
      prev = book.find(entry => entry.id === patch.id)
      if (!prev) throw new Error(`世界书中没有 id 为 ${patch.id} 的条目；新增条目不要传 id`)
    } else {
      const matches = titled(book, patch.title)
      if (matches.length > 1) {
        throw new Error(`世界书中有 ${matches.length} 条标题为「${patch.title}」的条目，请改用 id 指定：${matches.map(label).join('、')}`)
      }
      prev = matches[0]
    }
    if (prev) {
      const target = prev
      book = book.map(entry => (entry === target ? merge(target, patch) : entry))
    } else {
      if (!patch.title?.trim()) throw new Error('新增世界书条目必须提供 title')
      book.push(merge(undefined, patch))
    }
  }
  for (const ref of removals) {
    const byId = book.find(entry => entry.id === ref)
    const matches = byId ? [byId] : titled(book, ref)
    if (matches.length === 0) throw new Error(`世界书中没有 id 或标题为「${ref}」的条目`)
    if (matches.length > 1) {
      throw new Error(`世界书中有 ${matches.length} 条标题为「${ref}」的条目，请改用 id 指定：${matches.map(label).join('、')}`)
    }
    book = book.filter(entry => entry !== matches[0])
  }
  return book
}
