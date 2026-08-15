/** Character card data model and its zod schemas (storage + wire). */
import { z } from 'zod'

/** Where a lore entry is injected relative to the character definition. */
export const LORE_POSITIONS = [
  'system_top',
  'before_char',
  'after_char',
  'user_top',
  'assistant_top',
  'at_depth',
] as const
export type LorePosition = (typeof LORE_POSITIONS)[number]

/** One lorebook entry carried by a character card. */
export const LoreEntry = z.object({
  id: z.string(),
  /** Display title; also rendered as the section header on injection. */
  title: z.string().default(''),
  content: z.string().default(''),
  /** Trigger keywords; an empty list with constant=false never fires. */
  keys: z.array(z.string()).default([]),
  /** Treat each key as a regular expression instead of a substring. */
  useRegex: z.boolean().default(false),
  /** Always injected, regardless of keyword matches. */
  constant: z.boolean().default(false),
  position: z.enum(LORE_POSITIONS).default('after_char'),
  /** Sort order among entries of one position (ascending). */
  order: z.number().int().default(100),
  /** Message depth for at_depth entries. */
  depth: z.number().int().min(0).default(4),
  /** How many recent messages are scanned for keys (0 = plugin default). */
  scanDepth: z.number().int().min(0).default(0),
  /** Fire probability percentage for non-constant entries. */
  probability: z.number().min(0).max(100).default(100),
  enabled: z.boolean().default(true),
})
export type LoreEntry = z.infer<typeof LoreEntry>

/**
 * One regex script carried by a card (interchange-compatible subset).
 * The client applies the display-coloring subset: enabled, not prompt-only,
 * assistant placement, and a `color:` extractable from the replacement.
 * Everything else is stored losslessly for round-tripping exports.
 */
export const RegexScript = z.object({
  name: z.string().default(''),
  /** Raw pattern; may be the /pattern/flags form or carry inline (?i)(?s)(?m). */
  find: z.string(),
  /** Replacement template; display coloring reads the first inline `color:` from it. */
  replace: z.string().default(''),
  flags: z.string().default('g'),
  enabled: z.boolean().default(true),
  /** Display-side only (never applied to prompts). */
  markdownOnly: z.boolean().default(false),
  /** Prompt-side only (never displayed); stored for round-trip, not applied. */
  promptOnly: z.boolean().default(false),
  /** Which roles it applies to: 1 = user messages, 2 = assistant messages. */
  placement: z.array(z.number().int()).default([1, 2]),
})
export type RegexScript = z.infer<typeof RegexScript>

/** One locally stored character card. */
export const CharacterCard = z.object({
  id: z.string(),
  name: z.string(),
  /** Short human-facing intro shown on the card; not injected into prompts. */
  description: z.string().default(''),
  /** The full persona definition injected into the system prompt. */
  personality: z.string().default(''),
  /** Scene / world state at the start of the conversation. */
  scenario: z.string().default(''),
  /** Opening message shown (and prompt-injected) before the first turn. */
  firstMessage: z.string().default(''),
  /** Optional example dialogue that demonstrates the speaking style. */
  exampleDialogs: z.string().default(''),
  /** Author notes / hashtags; display only. */
  creatorNotes: z.string().default(''),
  tags: z.array(z.string()).default([]),
  book: z.array(LoreEntry).default([]),
  /** Card-carried regex scripts (display coloring on the client). */
  regexScripts: z.array(RegexScript).default([]),
  /** File name under the data dir's avatars/ folder, when an avatar exists. */
  avatar: z.string().optional(),
  favorite: z.boolean().default(false),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
})
export type CharacterCard = z.infer<typeof CharacterCard>

/** Per-session role-play state. */
export const SessionBinding = z.object({
  sessionId: z.string(),
  mode: z.enum(['roleplay', 'forge']),
  characterId: z.string().optional(),
  /** Per-session override of the global auto-image default. */
  autoImage: z.boolean().optional(),
  /** Per-session images-per-reply override; absent = follow the global setting. */
  imageCount: z.number().int().min(1).max(6).optional(),
  /** Per-session reference-image mode override; absent = follow the global setting. */
  referenceMode: z.enum(['none', 'avatar', 'custom']).optional(),
  /** One-shot stage direction appended to the NEXT user message, then cleared. */
  pendingInstruction: z.string().optional(),
  /** Filesystem path of the session's workspace (recorded by the dock; used for workspace-scoped stores). */
  workspacePath: z.string().optional(),
  /** Per-session override of the global choice-mode default. */
  choiceMode: z.boolean().optional(),
  updatedAt: z.number().int().default(0),
})
export type SessionBinding = z.infer<typeof SessionBinding>

/** Record persisted for one generated image. */
export const GeneratedImage = z.object({
  /** Content hash of (provider, prompt, parameters) — doubles as the file stem. */
  id: z.string(),
  prompt: z.string(),
  provider: z.string(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  createdAt: z.number().int().default(0),
  /** Pinned in the gallery's starred shelf. */
  starred: z.boolean().default(false),
})
export type GeneratedImage = z.infer<typeof GeneratedImage>
