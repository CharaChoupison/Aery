import type { Attachment } from './attachments'
import type { DuplicateHint } from './brainDuplicates'

/**
 * Le second cerveau : tout ce que l'utilisateur a choisi de garder (notes, réponses du chat,
 * fichiers, pages web), au même endroit.
 *
 * C'est aussi LA source des fichiers de référence des projets : un projet ne copie rien, il
 * pointe vers des éléments du cerveau (`projectIds`). Un même fichier peut servir à plusieurs
 * projets, et le retirer d'un projet ne le supprime pas du cerveau.
 *
 * Ce qui est seulement passé dans les conversations (pièces jointes, pages trouvées par la
 * recherche web) n'est PAS stocké ici : c'est l'onglet « Capturé », recalculé depuis l'historique
 * (voir projectSources.ts). On le garde dans le cerveau d'un clic, sinon ça deviendrait une décharge.
 */

export type BrainKind = 'note' | 'reply' | 'file' | 'web'

export interface BrainItem {
  id: string
  kind: BrainKind
  title: string
  /** Texte (Markdown pour les notes et les réponses, contenu brut pour un fichier). */
  content: string
  tags: string[]
  /** Projets qui s'en servent comme référence (envoyé au modèle dans leurs conversations). */
  projectIds: string[]
  /** Fichier importé : son nom et sa taille d'origine (pour le reconnaître dans les sources). */
  file?: { name: string; mimeType: string; size: number }
  /** Page web gardée. */
  url?: string
  /** Réponse gardée depuis le chat : pour pouvoir y retourner. */
  origin?: { conversationId: string; messageId?: string }
  /**
   * Dossier façon PARA (« 3 - Ressources/React »), choisi par le rangement ou à la main.
   * Absent = pas encore rangé (« Boîte de réception »). Sert aussi de dossier à l'export Obsidian.
   */
  folder?: string
  /** Notes liées (ids) : deviennent des liens [[…]] à l'export. */
  links?: string[]
  /** Note d'index (MOC) créée par le rangement : la liste des notes d'un thème. */
  moc?: boolean
  /** Dernier rangement de cet élément. Modifié après (updatedAt plus récent) = à ranger de nouveau. */
  tidiedAt?: number
  /** Doublon possible repéré à l'entrée (brainDuplicates.ts) : une suggestion, jamais appliquée seule. */
  duplicateOf?: DuplicateHint
  createdAt: number
  updatedAt: number
}

/**
 * Copie d'un élément gardée AVANT une modification automatique (rangement) ou une restauration.
 * Le contenu d'origine n'est donc jamais perdu.
 */
export interface BrainVersion {
  id: string
  itemId: string
  /** Rangement qui a fait la modification (pour pouvoir l'annuler en entier). */
  runId?: string
  reason: 'tidy' | 'restore' | 'merge'
  savedAt: number
  item: BrainItem
}

export const BRAIN_LIMITS = {
  title: 120,
  /** Une note très longue ne servirait à rien : le modèle la lirait par morceaux de toute façon. */
  content: 100_000,
  tags: 12,
  tag: 30,
  /** Fichiers importés dans le cerveau. */
  importChars: 100_000,
} as const

export const BRAIN_KIND_LABELS: Record<BrainKind, string> = {
  note: 'Note',
  reply: 'Réponse gardée',
  file: 'Fichier',
  web: 'Page web',
}

export function newBrainItem(fields: Partial<BrainItem> & Pick<BrainItem, 'kind'>): BrainItem {
  const now = Date.now()
  return sanitizeItem({ id: crypto.randomUUID(), title: '', content: '', tags: [], projectIds: [], createdAt: now, updatedAt: now, ...fields })
}

/** Nettoie un élément (titre, tags, tailles) avant de l'enregistrer. */
export function sanitizeItem(item: BrainItem): BrainItem {
  return {
    ...item,
    title: item.title.replace(/\s+/g, ' ').trim().slice(0, BRAIN_LIMITS.title),
    content: item.content.slice(0, BRAIN_LIMITS.content),
    tags: parseTags(item.tags.join(',')),
    projectIds: [...new Set(item.projectIds)],
    folder: item.folder ? sanitizeFolder(item.folder) || undefined : undefined,
    links: item.links ? [...new Set(item.links)].filter((id) => id !== item.id).slice(0, 30) : undefined,
    duplicateOf: item.duplicateOf?.of && item.duplicateOf.of !== item.id ? item.duplicateOf : undefined,
  }
}

// --- Dossiers (PARA) ---------------------------------------------------------------------

/**
 * Les grands dossiers de la méthode PARA (Tiago Forte) :
 *  - Projets : ce qui a un objectif et une fin (un exposé, une appli) ;
 *  - Domaines : ce qu'on suit dans la durée (études, santé, budget) ;
 *  - Ressources : les sujets qui intéressent (React, recettes…) ;
 *  - Archives : ce qui n'est plus actif.
 * Les numéros gardent l'ordre dans Obsidian (tri alphabétique).
 */
export const INBOX_FOLDER = '0 - Boîte de réception'
export const PARA_FOLDERS = ['1 - Projets', '2 - Domaines', '3 - Ressources', '4 - Archives'] as const

/** Un nom de fichier ou de dossier sans caractères interdits (macOS, Windows, Obsidian). */
export function safeName(name: string, max = 80): string {
  return name
    .replace(/[\\/:*?"<>|#^[\]{}\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, max)
    .trim()
}

/** « ressources / React » → « 3 - Ressources/React ». Premier niveau = un dossier PARA, 2 niveaux max. '' si invalide. */
export function sanitizeFolder(raw: string): string {
  const parts = raw.split('/').map((p) => safeName(p, 40)).filter(Boolean)
  if (parts.length === 0) return ''
  const top = fold(parts[0]).replace(/^\d+\s*-?\s*/, '')
  const para = [INBOX_FOLDER, ...PARA_FOLDERS].find((f) => {
    const name = fold(f).replace(/^\d+ - /, '')
    return top === name || top === name.replace(/s$/, '') || (name === 'boite de reception' && top === 'inbox')
  })
  if (!para) return ''
  // Sous-dossier avec une majuscule : « react » et « React » ne font pas deux dossiers.
  const sub = parts.slice(1, 2).map((p) => p.charAt(0).toLocaleUpperCase('fr') + p.slice(1))
  return [para, ...sub].join('/')
}

/** Tous les dossiers utilisés, triés. */
export function allFolders(items: BrainItem[]): string[] {
  return [...new Set(items.flatMap((i) => (i.folder ? [i.folder] : [])))].sort((a, b) => a.localeCompare(b, 'fr'))
}

// --- Liens [[…]] (format Obsidian) --------------------------------------------------------

const WIKILINK = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|([^\]\n]+))?\]\]/g

/** Retrouve une note par son titre (sans accents ni majuscules). */
export function findByTitle(items: BrainItem[], title: string): BrainItem | undefined {
  const t = fold(title.trim())
  return items.find((i) => fold(itemTitle(i)) === t) ?? items.find((i) => fold(safeName(itemTitle(i))) === fold(safeName(title)))
}

/**
 * Pour l'affichage dans l'appli : [[Titre]] → lien Markdown vers la note (#note:<id>), que le
 * rendu transforme en pastille cliquable. Un lien vers une note inconnue reste du texte.
 */
export function linkifyWikilinks(content: string, items: BrainItem[]): string {
  return content.replace(WIKILINK, (_all, target: string, alias?: string) => {
    const label = (alias ?? target).trim().replace(/[[\]]/g, '')
    const found = findByTitle(items, target)
    return found ? `[${label}](#note:${found.id})` : label
  })
}

/** Titres cités en [[…]] dans un texte. */
export function wikilinkTargets(content: string): string[] {
  return [...content.matchAll(WIKILINK)].map((m) => m[1].trim())
}

/** Notes liées à `item` : ses liens, ses [[…]], et celles qui pointent vers lui (rétroliens). */
export function relatedItems(item: BrainItem, items: BrainItem[]): { out: BrainItem[]; back: BrainItem[] } {
  const byId = new Map(items.map((i) => [i.id, i]))
  const out = new Map<string, BrainItem>()
  for (const id of item.links ?? []) {
    const found = byId.get(id)
    if (found) out.set(found.id, found)
  }
  for (const title of wikilinkTargets(item.content)) {
    const found = findByTitle(items, title)
    if (found && found.id !== item.id) out.set(found.id, found)
  }
  const title = fold(itemTitle(item))
  const back = items.filter(
    (i) =>
      i.id !== item.id &&
      !out.has(i.id) &&
      ((i.links ?? []).includes(item.id) || wikilinkTargets(i.content).some((t) => fold(t) === title)),
  )
  return { out: [...out.values()], back }
}

/** « React, idées ,  react » → ['react', 'idées'] : minuscules, sans #, sans doublon. */
export function parseTags(raw: string): string[] {
  const tags = raw
    .split(/[,;\n]/)
    .map((t) => t.replace(/^#+/, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, BRAIN_LIMITS.tag))
    .filter(Boolean)
  return [...new Set(tags)].slice(0, BRAIN_LIMITS.tags)
}

/** Titre à afficher (un élément sans titre garde quand même un nom). */
export function itemTitle(item: Pick<BrainItem, 'title' | 'content' | 'file' | 'url'>): string {
  return item.title || item.file?.name || item.url || firstLine(item.content) || 'Sans titre'
}

/** Première ligne utile d'un texte Markdown (sans #, *, >…), coupée à 80 caractères. */
export function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? ''
  return line.length > 80 ? `${line.slice(0, 80).trimEnd()}…` : line
}

// --- Lien avec les projets -------------------------------------------------------------

/** Les éléments rangés dans un projet (ses « fichiers de référence »), du plus ancien au plus récent. */
export function projectItems(items: BrainItem[], projectId: string): BrainItem[] {
  return items.filter((i) => i.projectIds.includes(projectId)).sort((a, b) => a.createdAt - b.createdAt)
}

/** Un élément vu comme un fichier texte (fenêtre du projet, message système). */
export function itemAsAttachment(item: BrainItem): Attachment {
  return {
    id: item.id,
    kind: 'text',
    name: item.file?.name ?? itemTitle(item),
    mimeType: item.file?.mimeType ?? 'text/markdown',
    size: item.file?.size ?? item.content.length,
    text: item.content,
  }
}

// --- Recherche --------------------------------------------------------------------------

/** Minuscules, sans accents : « Énergie » et « energie » se retrouvent. */
export const fold = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()

// Mots trop courants pour aider à trouver quoi que ce soit.
const STOP_WORDS = new Set(
  'le la les un une des du de d l et ou a au aux en dans sur pour par avec sans ce cet cette ces mon ma mes ton ta tes son sa ses que qui quoi est sont j je tu il elle on nous vous ils elles the of and to in is it'.split(
    ' ',
  ),
)

export function searchTerms(query: string): string[] {
  return [...new Set(fold(query).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP_WORDS.has(t)))]
}

export interface BrainHit {
  item: BrainItem
  score: number
  /** Extrait autour du premier mot trouvé dans le contenu. */
  snippet: string
}

function countOf(haystack: string, needle: string, max = 5): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1 && n < max; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

/** Texte sans les symboles Markdown les plus courants, sur une ligne (aperçus). */
export function plainText(text: string): string {
  return text.replace(/[#*_`>~]+/g, '').replace(/\s+/g, ' ').trim()
}

/** Extrait d'environ `size` caractères autour de la position `at`. */
function snippetAround(text: string, at: number, size = 220): string {
  const start = Math.max(0, at - size / 3)
  const raw = plainText(text.slice(start, start + size))
  return `${start > 0 ? '…' : ''}${raw}${start + size < text.length ? '…' : ''}`
}

/**
 * Recherche par mots-clés, entièrement locale. Score : titre ×5, tag ×4, contenu ×1 par occurrence
 * (5 au plus), bonus si tous les mots sont là, et si la phrase entière apparaît telle quelle.
 * (Pas de recherche « par le sens » : il faudrait des embeddings, que FreeLLMAPI ne fournit pas.)
 */
export function searchBrain(items: BrainItem[], query: string, limit = 20): BrainHit[] {
  const terms = searchTerms(query)
  if (terms.length === 0) return []
  const phrase = fold(query).trim()
  const hits: BrainHit[] = []
  for (const item of items) {
    const title = fold(itemTitle(item))
    const tags = item.tags.map(fold)
    const content = fold(item.content)
    let score = 0
    let matched = 0
    let firstAt = -1
    for (const term of terms) {
      const inTitle = title.includes(term)
      const inTags = tags.some((t) => t.includes(term))
      const inContent = countOf(content, term)
      if (inTitle || inTags || inContent) matched++
      score += (inTitle ? 5 : 0) + (inTags ? 4 : 0) + inContent
      const at = content.indexOf(term)
      if (at !== -1 && (firstAt === -1 || at < firstAt)) firstAt = at
    }
    if (matched === 0) continue
    if (matched === terms.length) score *= 1.5
    if (terms.length > 1 && (title.includes(phrase) || content.includes(phrase))) score += 6
    // fold() ne change pas la longueur pour le français courant : la position vaut dans le texte d'origine.
    const snippet = firstAt === -1 ? snippetAround(item.content, 0) : snippetAround(item.content, firstAt)
    hits.push({ item, score, snippet })
  }
  return hits.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt).slice(0, limit)
}

// --- Rangement automatique (titre + tags demandés au modèle) ----------------------------

export const ENRICH_PROMPT =
  'Tu ranges des notes dans un « second cerveau ». Pour le texte ci-dessous, propose un titre court (8 mots maximum) ' +
  'et de 1 à 4 tags (mots-clés en minuscules, sans #). Réponds UNIQUEMENT par un objet JSON : ' +
  '{"title": "…", "tags": ["…"]}. Écris dans la langue du texte.'

/** Lit la réponse du modèle (parfois entourée de texte ou de ```json). null si illisible. */
export function parseEnrichment(raw: string): { title: string; tags: string[] } | null {
  const match = /\{[\s\S]*\}/.exec(raw.replace(/<think>[\s\S]*?<\/think>/gi, ''))
  if (!match) return null
  try {
    const parsed: unknown = JSON.parse(match[0])
    if (typeof parsed !== 'object' || parsed === null) return null
    const r = parsed as Record<string, unknown>
    const title = typeof r.title === 'string' ? r.title.replace(/^["'«\s]+|["'»\s.]+$/g, '').trim() : ''
    const tags = Array.isArray(r.tags) ? parseTags(r.tags.filter((t): t is string => typeof t === 'string').join(',')).slice(0, 4) : []
    return title || tags.length ? { title: title.slice(0, BRAIN_LIMITS.title), tags } : null
  } catch {
    return null
  }
}

/** Tous les tags utilisés, du plus fréquent au moins fréquent. */
export function allTags(items: BrainItem[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
