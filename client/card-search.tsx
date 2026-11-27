/** Card search shared by the session picker and the settings card manager. */
import type { ReactNode } from 'react'
import type { CardSummary } from './api.ts'
import { useT } from './i18n.ts'

/** Below this many cards the whole list fits on screen and a search box is only clutter. */
export const CARD_SEARCH_MIN = 8

/**
 * Cards matching every whitespace-separated term of `query`, in their given
 * order. A term matches anywhere in the name, author notes, description or
 * tags, case-insensitively; an empty query keeps everything.
 */
export function filterCards(cards: CardSummary[], query: string): CardSummary[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return cards
  return cards.filter(card => {
    const text = [card.name, card.creatorNotes, card.description, card.tags.join(' ')].join('\n').toLowerCase()
    return terms.every(term => text.includes(term))
  })
}

export function CardSearch({ value, onChange }: { value: string; onChange: (value: string) => void }): ReactNode {
  const t = useT()
  return (
    <input
      className="rp-search"
      type="search"
      value={value}
      placeholder={t('rp.cards.search')}
      aria-label={t('rp.cards.search')}
      onChange={event => onChange(event.target.value)}
    />
  )
}
