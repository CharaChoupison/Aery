import { BRAIN_LIMITS, ENRICH_PROMPT, fold, itemTitle, plainText, searchTerms, type BrainItem } from './brain'

/**
 * Repérer les doublons à l'entrée du cerveau (réponse gardée, /note).
 *
 * 1. D'abord en local, sans aucune requête : on compare les mots de la nouvelle note à ceux des
 *    autres éléments. Rien de proche = rien de plus (c'est le cas le plus fréquent).
 * 2. Texte identique : c'est sûr, pas besoin du modèle.
 * 3. Sinon, les candidats (3 max) sont ajoutés à la requête de titre + tags qui part de toute
 *    façon (ENRICH_PROMPT) : le modèle dit si l'un d'eux traite VRAIMENT du même sujet.
 *
 * Rien n'est jamais fusionné ni supprimé tout seul : on note seulement une suggestion
 * (`duplicateOf`), et la personne choisit « Fusionner » ou « Garder les deux » sur la page.
 */

export interface DuplicateHint {
  /** Élément qui ressemble à celui-ci. */
  of: string
  /** Explication courte (du modèle, ou « Texte identique »). */
  reason: string
  exact?: boolean
  at: number
}

export interface DuplicateCandidate {
  item: BrainItem
  score: number
  exact: boolean
}

/** Au-delà, on ne lit que le début : assez pour reconnaître un sujet, et ça reste rapide. */
const COMPARE_CHARS = 20_000

function termsOf(item: BrainItem): Set<string> {
  return new Set(searchTerms(`${item.title} ${item.content.slice(0, COMPARE_CHARS)}`))
}

/** Texte comparable : sans accents, majuscules, ponctuation ni Markdown. */
const normalized = (text: string) => fold(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

/**
 * Éléments qui ressemblent à `item`, du plus proche au moins proche.
 * Mesures : Jaccard (mots en commun / mots en tout) et inclusion (mots en commun / mots du plus
 * court : une note courte entièrement contenue dans une longue compte aussi).
 */
export function findDuplicateCandidates(item: BrainItem, items: BrainItem[], limit = 3): DuplicateCandidate[] {
  const text = normalized(item.content)
  if (text.length < 20) return []
  const mine = termsOf(item)
  const title = fold(itemTitle(item))
  const found: DuplicateCandidate[] = []
  for (const other of items) {
    if (other.id === item.id || other.moc || !other.content.trim()) continue
    if (normalized(other.content) === text) {
      found.push({ item: other, score: 1, exact: true })
      continue
    }
    const theirs = termsOf(other)
    let common = 0
    for (const t of mine) if (theirs.has(t)) common++
    const smallest = Math.min(mine.size, theirs.size)
    const jaccard = common / (mine.size + theirs.size - common || 1)
    const inclusion = smallest >= 12 ? common / smallest : 0
    const sameTitle = title.length > 3 && fold(itemTitle(other)) === title
    const score = Math.max(jaccard, inclusion * 0.8, sameTitle ? 0.5 : 0)
    if (jaccard >= 0.3 || inclusion >= 0.6 || sameTitle) found.push({ item: other, score, exact: false })
  }
  return found.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt).slice(0, limit)
}

const LETTERS = ['A', 'B', 'C', 'D', 'E']

/**
 * Message système : celui du titre + tags, plus la question des doublons s'il y a des candidats.
 * Les candidats sont nommés A, B, C (les modèles abîment souvent les longs identifiants).
 */
export function buildEnrichPrompt(candidates: DuplicateCandidate[]): string {
  if (candidates.length === 0) return ENRICH_PROMPT
  const list = candidates
    .slice(0, LETTERS.length)
    .map((c, i) => `${LETTERS[i]}. « ${itemTitle(c.item)} »\n${plainText(c.item.content.slice(0, 900)).slice(0, 600)}`)
    .join('\n\n')
  return (
    `${ENRICH_PROMPT}\n\n` +
    'Le cerveau contient déjà ces notes proches :\n\n' +
    `${list}\n\n` +
    'Ajoute au JSON "duplicate" : la lettre de la note qui traite du MÊME sujet précis que le texte ' +
    '(même question, même information, ou le texte la complète directement), sinon null. ' +
    'Un simple thème commun ne suffit pas : dans le doute, null. ' +
    'Et "reason" : une phrase courte qui explique, en français, sans citer la lettre. ' +
    'Exemple : {"title": "…", "tags": ["…"], "duplicate": "A", "reason": "…"}'
  )
}

/** Le doublon désigné par le modèle (null = aucun, ou réponse illisible). */
export function parseDuplicate(raw: string, candidates: DuplicateCandidate[]): { id: string; reason: string } | null {
  const match = /\{[\s\S]*\}/.exec(raw.replace(/<think>[\s\S]*?<\/think>/gi, ''))
  if (!match) return null
  try {
    const r = JSON.parse(match[0]) as Record<string, unknown>
    if (typeof r.duplicate !== 'string') return null
    const index = LETTERS.indexOf(r.duplicate.trim().replace(/[^A-Za-z]/g, '').toUpperCase())
    const target = candidates[index]
    if (index < 0 || !target) return null
    const reason =
      typeof r.reason === 'string'
        ? r.reason
            .replace(/\b(la )?note [A-E]\b/g, 'l’autre note')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200)
        : ''
    return { id: target.item.id, reason: reason || 'Même sujet.' }
  } catch {
    return null
  }
}

/**
 * `source` ajouté à la fin de `target` (sous un intertitre daté) : rien n'est remplacé.
 * Tags, projets et liens réunis. null si le résultat dépasserait la taille maximale d'une note
 * (on préfère ne pas fusionner que couper du texte).
 */
export function mergeItems(target: BrainItem, source: BrainItem, now = Date.now()): BrainItem | null {
  const date = new Date(now).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })
  const added = `\n\n---\n\n## ${itemTitle(source)}\n\n*Ajouté le ${date}.*\n\n${source.content.trim()}\n`
  const content = target.content.trimEnd() + added
  if (content.length > BRAIN_LIMITS.content) return null
  const links = [...new Set([...(target.links ?? []), ...(source.links ?? [])])].filter((id) => id !== target.id && id !== source.id)
  return {
    ...target,
    content,
    // « dependances » et « dépendances » : un seul tag (celui de la cible d'abord).
    tags: [...new Map([...target.tags, ...source.tags].reverse().map((t) => [fold(t), t])).values()].reverse().slice(0, BRAIN_LIMITS.tags),
    projectIds: [...new Set([...target.projectIds, ...source.projectIds])],
    links: links.length ? links : undefined,
    duplicateOf: undefined,
    updatedAt: now,
  }
}
