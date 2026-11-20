import {
  allFolders,
  findByTitle,
  firstLine,
  fold,
  INBOX_FOLDER,
  itemTitle,
  newBrainItem,
  parseTags,
  PARA_FOLDERS,
  sanitizeFolder,
  sanitizeItem,
  BRAIN_KIND_LABELS,
  BRAIN_LIMITS,
  type BrainItem,
  type BrainKind,
} from './brain'

/**
 * Rangement automatique du second cerveau (une fois par semaine, ou « Ranger maintenant »).
 *
 * Le modèle reçoit les éléments ajoutés ou modifiés depuis le dernier rangement, par petits lots,
 * et propose pour chacun : un dossier PARA, un titre, des tags, des notes liées et, pour les notes
 * courtes, une version légèrement réécrite (fautes, mise en forme, liens [[…]]). Il peut aussi
 * proposer des notes d'index (MOC) qui regroupent un thème.
 *
 * Garde-fous :
 *  - une copie de chaque élément est gardée AVANT modification (table brainVersions) ;
 *  - une réécriture qui supprime trop de texte est refusée (acceptRewrite) ;
 *  - les fichiers importés et les pages web ne sont jamais réécrits, seulement rangés ;
 *  - un élément modifié pendant le rangement n'est pas touché.
 *
 * Ce fichier ne contient que la logique (testable sans réseau) : l'appel au modèle est fourni par useBrainTidy.
 */

// --- Planning ------------------------------------------------------------------------------

export interface TidySchedule {
  enabled: boolean
  /** 0 = dimanche … 6 = samedi (comme Date.getDay). */
  day: number
  /** Heure locale, 0 à 23. */
  hour: number
  /** Activé depuis : un rendez-vous plus ancien ne compte pas (pas de rangement surprise en l'activant). */
  since: number
}

export const DEFAULT_TIDY_SCHEDULE: TidySchedule = { enabled: true, day: 0, hour: 20, since: 0 }

export const DAY_LABELS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']

/** Dernier rendez-vous (jour + heure) passé, à la minute près. */
export function lastSlot(schedule: Pick<TidySchedule, 'day' | 'hour'>, now: number): number {
  const d = new Date(now)
  d.setHours(schedule.hour, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() - schedule.day + 7) % 7))
  if (d.getTime() > now) d.setDate(d.getDate() - 7)
  return d.getTime()
}

/** Prochain rendez-vous. */
export function nextSlot(schedule: Pick<TidySchedule, 'day' | 'hour'>, now: number): number {
  const d = new Date(lastSlot(schedule, now))
  d.setDate(d.getDate() + 7)
  return d.getTime()
}

/** Faut-il ranger maintenant ? (Le rendez-vous est passé et aucun rangement n'a eu lieu depuis.) */
export function isDue(schedule: TidySchedule, lastRunAt: number, now: number): boolean {
  if (!schedule.enabled) return false
  const slot = lastSlot(schedule, now)
  return slot > Math.max(lastRunAt, schedule.since)
}

// --- Ce qu'il faut ranger --------------------------------------------------------------------

/** Ajouté ou modifié depuis son dernier rangement (les notes d'index sont gérées à part). */
export function needsTidy(item: BrainItem): boolean {
  return !item.moc && (!item.tidiedAt || item.updatedAt > item.tidiedAt)
}

/** Au-delà, on ne propose pas de réécriture (le modèle n'aurait pas tout le texte, ou le renverrait mal). */
export const REWRITE_MAX = 4000
/** Texte d'un élément envoyé au modèle quand il n'est pas réécrit. */
const EXCERPT = 1500
/** Taille d'un lot (caractères de contenu, et nombre d'éléments). */
const BATCH_CHARS = 9000
const BATCH_ITEMS = 6
/** Pas plus d'éléments par rangement (le reste attendra le suivant). */
export const MAX_PER_RUN = 60

export function canRewrite(item: BrainItem): boolean {
  return (item.kind === 'note' || item.kind === 'reply') && !item.moc && item.content.trim().length > 0 && item.content.length <= REWRITE_MAX
}

/** Découpe en lots qui tiennent dans une requête. */
export function makeBatches(items: BrainItem[]): BrainItem[][] {
  const batches: BrainItem[][] = []
  let current: BrainItem[] = []
  let size = 0
  for (const item of items.slice(0, MAX_PER_RUN)) {
    const cost = canRewrite(item) ? item.content.length : Math.min(item.content.length, EXCERPT)
    if (current.length && (current.length >= BATCH_ITEMS || size + cost > BATCH_CHARS)) {
      batches.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += cost
  }
  if (current.length) batches.push(current)
  return batches
}

// --- La requête --------------------------------------------------------------------------------

export const TIDY_PROMPT = `Tu ranges le « second cerveau » d'une personne (des notes au format Obsidian) avec la méthode PARA :
- "1 - Projets" : ce qui a un objectif et une fin (un exposé, une appli, un voyage…)
- "2 - Domaines" : ce qu'on suit dans la durée (études, santé, budget, travail…)
- "3 - Ressources" : sujets de référence ou d'intérêt (React, recettes, articles…)
- "4 - Archives" : ce qui n'est plus actif
Un seul sous-dossier thématique au plus, par exemple "3 - Ressources/React". Réutilise les dossiers existants quand ça colle.

Pour chaque élément à ranger (ids n1, n2…), donne :
- "folder" : son dossier ;
- "title" : un titre clair et court (garde le titre actuel s'il est bon) ;
- "tags" : 1 à 5 tags en minuscules, sans # ;
- "links" : 0 à 5 notes vraiment liées, par leur titre exact (notes existantes) ou leur id (n1…) ;
- "content" : SEULEMENT pour les éléments marqués « réécriture possible », et seulement si c'est utile : le même texte en Markdown, légèrement amélioré (fautes corrigées, titres ou listes si ça aide, liens [[Titre exact]] vers les notes liées là où ils ont du sens). Ne supprime AUCUNE information, n'invente rien, garde la langue et le ton. Pas de frontmatter. Sinon, omets "content".
Tu peux aussi proposer des notes d'index ("mocs") qui regroupent au moins 3 notes d'un même thème (0 à 2 par réponse).

Réponds UNIQUEMENT par un objet JSON, sans texte autour :
{"notes":[{"id":"n1","folder":"…","title":"…","tags":["…"],"links":["…"],"content":"…"}],"mocs":[{"title":"…","folder":"…","description":"…","notes":["n1","Titre existant"]}]}`

/** Le message « user » d'un lot : le contexte (dossiers, notes existantes), puis les éléments à ranger. */
export function buildTidyRequest(batch: BrainItem[], all: BrainItem[]): string {
  const inBatch = new Set(batch.map((i) => i.id))
  const folders = allFolders(all)
  const known = all
    .filter((i) => !inBatch.has(i.id))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 120)
    .map((i) => `- ${itemTitle(i)}${i.folder ? ` (${i.folder})` : ''}${i.moc ? ' [index]' : ''}`)
  const parts = [
    `Dossiers existants : ${folders.length ? folders.join(' · ') : `aucun pour l'instant (${PARA_FOLDERS.join(', ')})`}`,
    known.length ? `Notes existantes :\n${known.join('\n')}` : 'Aucune autre note pour l’instant.',
    'Éléments à ranger :',
  ]
  batch.forEach((item, i) => {
    const rewrite = canRewrite(item)
    const text = rewrite ? item.content : item.content.slice(0, EXCERPT) + (item.content.length > EXCERPT ? '\n[…]' : '')
    parts.push(
      [
        `### n${i + 1} (${BRAIN_KIND_LABELS[item.kind]}${rewrite ? ', réécriture possible' : ''})`,
        `Titre actuel : ${itemTitle(item)}`,
        item.tags.length ? `Tags : ${item.tags.join(', ')}` : '',
        item.folder ? `Dossier actuel : ${item.folder}` : '',
        item.url ? `Adresse : ${item.url}` : '',
        text.trim() ? `Contenu :\n<<<\n${text}\n>>>` : '(pas de contenu)',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  })
  return parts.join('\n\n')
}

// --- La réponse -----------------------------------------------------------------------------

export interface NoteProposal {
  folder: string
  title: string
  tags: string[]
  links: string[]
  content?: string
}

export interface MocProposal {
  title: string
  folder: string
  description: string
  notes: string[]
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const strList = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, max) : [])

/** Lit la réponse du modèle (entourée ou non de texte, de ```json, de <think>). null si illisible. */
export function parseTidyResponse(raw: string): { notes: Map<string, NoteProposal>; mocs: MocProposal[] } | null {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  const notes = new Map<string, NoteProposal>()
  for (const n of Array.isArray(r.notes) ? r.notes : []) {
    if (typeof n !== 'object' || n === null) continue
    const o = n as Record<string, unknown>
    const id = str(o.id, 10).toLowerCase()
    if (!/^n\d+$/.test(id)) continue
    notes.set(id, {
      folder: str(o.folder, 120),
      title: str(o.title, BRAIN_LIMITS.title),
      tags: strList(o.tags, 5),
      links: strList(o.links, 5),
      content: typeof o.content === 'string' && o.content.trim() ? o.content : undefined,
    })
  }
  const mocs: MocProposal[] = []
  for (const m of Array.isArray(r.mocs) ? r.mocs.slice(0, 2) : []) {
    if (typeof m !== 'object' || m === null) continue
    const o = m as Record<string, unknown>
    const title = str(o.title, BRAIN_LIMITS.title)
    const notesOf = strList(o.notes, 40)
    if (title && notesOf.length >= 3) mocs.push({ title, folder: str(o.folder, 120), description: str(o.description, 600), notes: notesOf })
  }
  return notes.size || mocs.length ? { notes, mocs } : null
}

/** Retire un frontmatter YAML (on le génère nous-mêmes à l'export) et les ``` autour du texte. */
export function stripFrontmatter(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md)?\n([\s\S]*)\n```\s*$/i, '$1')
    .replace(/^\s*---\n[\s\S]*?\n---\n/, '')
    .trim()
}

/** Mots (4 lettres ou plus) d'un texte, sans accents. */
function words(text: string): Set<string> {
  return new Set(fold(text).match(/[\p{L}\p{N}]{4,}/gu) ?? [])
}

/**
 * Une réécriture est acceptée seulement si elle garde l'essentiel : longueur comparable
 * et au moins 80 % des mots de l'original. Sinon on garde le texte d'origine.
 */
export function acceptRewrite(original: string, rewritten: string): boolean {
  const next = stripFrontmatter(rewritten)
  if (!next || next === original.trim()) return false
  if (next.length < original.length * 0.75 || next.length > original.length * 1.8 + 600) return false
  const before = words(original)
  if (before.size === 0) return true
  const after = words(next)
  let kept = 0
  for (const w of before) if (after.has(w)) kept++
  return kept / before.size >= 0.8
}

// --- Application ----------------------------------------------------------------------------

/** Ce que le rangement a changé sur un élément (pour le résumé). */
export interface TidyChange {
  itemId: string
  title: string
  kind: BrainKind
  fromFolder?: string
  toFolder?: string
  /** Ancien titre, si le titre a changé. */
  oldTitle?: string
  addedTags: string[]
  rewritten: boolean
  links: number
  /** Note d'index créée par ce rangement. */
  created?: boolean
}

export interface TidyRun {
  id: string
  at: number
  trigger: 'auto' | 'manual'
  status: 'done' | 'partial' | 'error' | 'undone'
  /** Éléments qui attendaient d'être rangés. */
  scanned: number
  changes: TidyChange[]
  errors: string[]
  model?: string
  /** Export vers le dossier Obsidian, s'il y en a un. */
  export?: { written: number; removed: number; backedUp: number; error?: string }
}

/** Le titre peut-il être remplacé ? Seulement s'il a été deviné (vide, première ligne), pas choisi. */
function titleIsGuessed(item: BrainItem): boolean {
  if (item.kind === 'file' || item.kind === 'web') return false
  return !item.title.trim() || item.title === firstLine(item.content) || (item.kind === 'reply' && item.updatedAt === item.createdAt)
}

/**
 * Applique une proposition à un élément. Renvoie le nouvel élément (ou null si rien ne change)
 * et le détail pour le résumé.
 */
export function applyProposal(
  item: BrainItem,
  p: NoteProposal,
  resolveLink: (ref: string) => BrainItem | undefined,
  now: number,
): { after: BrainItem; change: TidyChange } {
  const folder = sanitizeFolder(p.folder) || item.folder
  const title = p.title && titleIsGuessed(item) ? p.title : item.title
  const tags = parseTags([...item.tags, ...p.tags].join(','))
  const linked = p.links.map(resolveLink).filter((i): i is BrainItem => i !== undefined && i.id !== item.id).map((i) => i.id)
  const links = [...new Set([...(item.links ?? []), ...linked])]
  const rewritten = Boolean(p.content && canRewrite(item) && acceptRewrite(item.content, p.content))
  const after = sanitizeItem({
    ...item,
    folder,
    title,
    tags,
    links: links.length ? links : undefined,
    content: rewritten && p.content ? stripFrontmatter(p.content) : item.content,
    tidiedAt: now,
    updatedAt: now,
  })
  return {
    after,
    change: {
      itemId: item.id,
      title: itemTitle(after),
      kind: item.kind,
      fromFolder: item.folder,
      toFolder: after.folder,
      oldTitle: after.title !== item.title ? itemTitle(item) : undefined,
      addedTags: after.tags.filter((t) => !item.tags.includes(t)),
      rewritten,
      links: (after.links?.length ?? 0) - (item.links?.length ?? 0),
    },
  }
}

/** Contenu d'une note d'index : la description, puis un lien [[…]] par note. */
export function mocContent(description: string, notes: BrainItem[]): string {
  const list = [...notes]
    .sort((a, b) => itemTitle(a).localeCompare(itemTitle(b), 'fr'))
    .map((n) => `- [[${itemTitle(n)}]]`)
    .join('\n')
  return [description.trim(), '## Notes', list].filter(Boolean).join('\n\n')
}

/**
 * Note d'index proposée : on crée la note, ou on complète celle qui porte déjà ce titre
 * (seulement si c'est une note d'index : une note écrite à la main n'est jamais écrasée).
 */
export function applyMoc(
  m: MocProposal,
  resolveLink: (ref: string) => BrainItem | undefined,
  all: BrainItem[],
  now: number,
): { before?: BrainItem; after: BrainItem; change: TidyChange } | null {
  const notes = [...new Map(m.notes.map(resolveLink).filter((i): i is BrainItem => i !== undefined && !i.moc).map((i) => [i.id, i])).values()]
  if (notes.length < 3) return null
  const existing = findByTitle(all, m.title)
  if (existing && !existing.moc) return null
  if (existing) {
    const ids = [...new Set([...(existing.links ?? []), ...notes.map((n) => n.id)])]
    const linked = ids.map((id) => all.find((i) => i.id === id) ?? notes.find((n) => n.id === id)).filter((i): i is BrainItem => i !== undefined)
    const after = sanitizeItem({ ...existing, links: ids, content: mocContent(m.description || firstLine(existing.content), linked), tidiedAt: now, updatedAt: now })
    if (after.content === existing.content) return null
    return {
      before: existing,
      after,
      change: { itemId: existing.id, title: itemTitle(after), kind: 'note', toFolder: after.folder, fromFolder: existing.folder, addedTags: [], rewritten: true, links: ids.length - (existing.links?.length ?? 0) },
    }
  }
  const folder = sanitizeFolder(m.folder) || notes.find((n) => n.folder)?.folder || '3 - Ressources'
  const after = newBrainItem({
    kind: 'note',
    moc: true,
    title: m.title,
    folder,
    tags: ['index'],
    links: notes.map((n) => n.id),
    content: mocContent(m.description, notes),
    createdAt: now,
    updatedAt: now,
    tidiedAt: now,
  })
  return { after, change: { itemId: after.id, title: m.title, kind: 'note', toFolder: folder, addedTags: [], rewritten: false, links: notes.length, created: true } }
}

/** Résumé en une ligne d'un rangement. */
export function runSummary(run: TidyRun): string {
  if (run.status === 'error' && run.changes.length === 0) return run.errors[0] ?? 'Le rangement a échoué.'
  if (run.scanned === 0 && run.changes.length === 0) return 'Rien de nouveau à ranger.'
  const moved = run.changes.filter((c) => !c.created && c.toFolder !== c.fromFolder).length
  const rewritten = run.changes.filter((c) => c.rewritten && !c.created).length
  const created = run.changes.filter((c) => c.created).length
  const links = run.changes.reduce((n, c) => n + Math.max(0, c.links), 0)
  const n = run.changes.filter((c) => !c.created).length
  const parts = [
    `${n} élément${n > 1 ? 's' : ''} rangé${n > 1 ? 's' : ''}`,
    moved && `${moved} déplacé${moved > 1 ? 's' : ''}`,
    rewritten && `${rewritten} réécrit${rewritten > 1 ? 's' : ''}`,
    links && `${links} lien${links > 1 ? 's' : ''}`,
    created && `${created} index créé${created > 1 ? 's' : ''}`,
  ].filter(Boolean)
  return parts.join(' · ')
}

export { INBOX_FOLDER }
