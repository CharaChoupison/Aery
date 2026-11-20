import type { LucideIcon } from 'lucide-react'
import type { Attachment } from '@/lib/attachments'

/**
 * Commandes slash du champ de saisie (« /new », « /model … »…).
 *
 * Ce fichier ne contient que la partie « pure » : types, découpage du texte tapé, filtrage du menu,
 * et les textes envoyés au modèle par les commandes de prompt. Les actions (changer de modèle,
 * renommer…) sont branchées dans useSlashCommands, qui connaît l'état de l'appli.
 */

/** Une proposition d'argument dans le menu (ex. un modèle pour /model). */
export interface CommandSuggestion {
  value: string
  label: string
  detail?: string
}

export interface SlashCommand {
  /** Sans la barre oblique : « model ». */
  name: string
  description: string
  icon: LucideIcon
  /** Aide sur l'argument, affichée après le nom : « <modèle> », « [consigne] ». */
  argHint?: string
  /** Raison pour laquelle la commande est indisponible maintenant (absent = disponible). */
  disabled?: string
  /** true : la commande envoie un message (les pièces jointes partent avec). */
  sends?: boolean
  /** Commande créée par l'utilisateur dans les Paramètres. */
  custom?: boolean
  /** Propositions pour l'argument, filtrées sur ce qui est déjà tapé. */
  suggest?: (arg: string) => CommandSuggestion[]
  /** Exécute la commande. Renvoie un message d'erreur, ou rien si tout s'est bien passé. */
  run: (arg: string, attachments: Attachment[]) => string | void
}

/** Ce qui est tapé dans le champ, s'il s'agit d'une commande. */
export interface ParsedCommand {
  name: string // en minuscules
  arg: string // le reste, sans les espaces autour
  /** false tant qu'on tape encore le nom (pas encore d'espace après). */
  hasArg: boolean
}

/**
 * « /model  gpt-4o » → { name: 'model', arg: 'gpt-4o', hasArg: true }.
 * null si le texte ne commence pas par « / » suivi d'une lettre (« /etc/hosts » reste un message).
 */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-z0-9][a-z0-9-]*)?(?:(\s)([\s\S]*))?$/i.exec(text)
  if (!match) return null
  const name = (match[1] ?? '').toLowerCase()
  if (name === '' && match[2]) return null // « / bonjour »
  return { name, arg: (match[3] ?? '').trim(), hasArg: match[2] !== undefined }
}

/** Commandes qui correspondent au début tapé : d'abord celles qui commencent pareil, puis les autres. */
export function matchCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase()
  const starts = commands.filter((c) => c.name.startsWith(q))
  const contains = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.description.toLowerCase().includes(q)))
  return [...starts, ...contains]
}

/** Filtre de propositions commun (insensible à la casse et aux accents). */
export function filterSuggestions(items: CommandSuggestion[], arg: string, max = 8): CommandSuggestion[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
  const q = fold(arg)
  if (!q) return items.slice(0, max)
  const starts = items.filter((i) => fold(i.value).startsWith(q) || fold(i.label).startsWith(q))
  const contains = items.filter((i) => !starts.includes(i) && (fold(i.value).includes(q) || fold(i.label).includes(q)))
  return [...starts, ...contains].slice(0, max)
}

/** Premier mot de l'argument, et le reste (« anglais bonjour à tous » → ['anglais', 'bonjour à tous']). */
export function splitFirstWord(arg: string): [string, string] {
  const match = /^(\S+)\s*([\s\S]*)$/.exec(arg.trim())
  return match ? [match[1], match[2].trim()] : ['', '']
}

// --- Textes des commandes de prompt ---------------------------------------------------

export const LANGUAGES = ['anglais', 'espagnol', 'allemand', 'italien', 'portugais', 'néerlandais', 'japonais', 'chinois', 'coréen', 'arabe', 'russe', 'français']
export const CODE_LANGUAGES = ['typescript', 'javascript', 'python', 'rust', 'html', 'css', 'sql', 'bash', 'java', 'go', 'swift', 'json']

export const PROMPTS = {
  summary: (instruction: string) =>
    'Résume notre conversation jusqu’ici en quelques points clés (décisions, résultats, questions encore ouvertes).' +
    (instruction ? `\nConsigne : ${instruction}` : ''),
  translate: (language: string, text: string) =>
    text
      ? `Traduis ce texte en ${language}. Réponds uniquement par la traduction, sans commentaire.\n\n${text}`
      : `Traduis ta dernière réponse en ${language}. Réponds uniquement par la traduction.`,
  fix: (text: string) =>
    'Corrige l’orthographe, la grammaire et la ponctuation de ce texte, sans changer son sens ni son ton. ' +
    'Donne le texte corrigé, puis la liste des corrections importantes.\n\n' +
    text,
  explain: (topic: string) =>
    topic
      ? `Explique-moi simplement, comme à un débutant, avec un exemple concret : ${topic}`
      : 'Explique plus simplement ta dernière réponse, comme à un débutant, avec un exemple concret.',
  code: (language: string, request: string) =>
    `Réponds uniquement avec du code ${language}, dans un seul bloc, avec des commentaires courts et sans explication autour.\n\n${request}`,
}

// --- Commandes personnalisées (Paramètres › Commandes) ----------------------------------

export interface CustomCommand {
  id: string
  name: string
  description: string
  /** Texte envoyé. « {{texte}} » est remplacé par ce qui suit la commande (sinon ajouté à la fin). */
  prompt: string
}

export const CUSTOM_LIMITS = { count: 50, name: 24, description: 100, prompt: 4000 } as const

/** Nom autorisé : lettres minuscules sans accent, chiffres et tirets (« mail-pro »). */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9-]*$/

export const PLACEHOLDER = '{{texte}}'

/** Le message envoyé par une commande personnalisée. */
export function expandCustom(prompt: string, arg: string): string {
  if (prompt.includes(PLACEHOLDER)) return prompt.split(PLACEHOLDER).join(arg).trim()
  return arg ? `${prompt.trim()}\n\n${arg}` : prompt.trim()
}

/** Message d'erreur si le nom ne convient pas (null = OK). */
export function commandNameError(name: string, taken: string[]): string | null {
  if (!name) return 'Donne un nom à la commande.'
  if (name.length > CUSTOM_LIMITS.name) return `${CUSTOM_LIMITS.name} caractères maximum.`
  if (!COMMAND_NAME.test(name)) return 'Lettres minuscules sans accent, chiffres et tirets seulement.'
  if (taken.includes(name)) return `La commande /${name} existe déjà.`
  return null
}

/** Validation de ce qui vient de localStorage (peut être n'importe quoi). */
export function sanitizeCustomCommands(raw: unknown): CustomCommand[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: CustomCommand[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.toLowerCase().slice(0, CUSTOM_LIMITS.name) : ''
    const prompt = typeof r.prompt === 'string' ? r.prompt.slice(0, CUSTOM_LIMITS.prompt) : ''
    if (!COMMAND_NAME.test(name) || !prompt.trim() || seen.has(name)) continue
    seen.add(name)
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 64) : crypto.randomUUID(),
      name,
      description: typeof r.description === 'string' ? r.description.slice(0, CUSTOM_LIMITS.description) : '',
      prompt,
    })
    if (out.length >= CUSTOM_LIMITS.count) break
  }
  return out
}

/** Noms des commandes intégrées (une commande personnalisée ne peut pas les reprendre). */
export const BUILTIN_NAMES = [
  'new',
  'model',
  'search',
  'nosearch',
  'fusion',
  'retry',
  'title',
  'move',
  'usage',
  'resume',
  'traduis',
  'corrige',
  'explique',
  'code',
]
