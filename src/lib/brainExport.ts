import { findByTitle, INBOX_FOLDER, itemTitle, safeName, type BrainItem } from './brain'
import type { Project } from './projects'
import { IS_TAURI, invokeCommand } from './transport'

/**
 * Export du second cerveau en dossier Markdown ouvrable dans Obsidian (un « coffre ») :
 *  - un fichier .md par élément, rangé dans son dossier PARA (sinon « 0 - Boîte de réception ») ;
 *  - un frontmatter YAML en tête (titre, type, tags, dates, adresse…) ;
 *  - les liens [[…]] pointent vers les NOMS DE FICHIERS (c'est comme ça qu'Obsidian les résout),
 *    avec le vrai titre en alias si le nom a dû être simplifié.
 *
 * Ce fichier construit seulement la liste des fichiers. L'écriture se fait côté Rust (vault.rs),
 * dans un dossier choisi via la fenêtre de macOS, avec une copie de sauvegarde de tout fichier
 * modifié dans Obsidian avant de le remplacer.
 */

export interface VaultFile {
  /** Chemin relatif, « / » entre les dossiers, toujours en .md. */
  path: string
  content: string
}

/** Noms de fichiers uniques dans tout le coffre (Obsidian résout [[Nom]] sur tout le coffre). */
export function fileNames(items: BrainItem[]): Map<string, string> {
  const names = new Map<string, string>()
  const used = new Set<string>()
  const sorted = [...items].sort((a, b) => a.createdAt - b.createdAt)
  for (const item of sorted) {
    const base = safeName(itemTitle(item)) || 'Sans titre'
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`
    used.add(name.toLowerCase())
    names.set(item.id, name)
  }
  return names
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10)
/** Chaîne YAML sûre : JSON est un sous-ensemble de YAML (guillemets, échappements). */
const yamlString = (s: string) => JSON.stringify(s)
/** Les tags Obsidian n'acceptent pas les espaces. */
const obsidianTag = (t: string) => t.replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_\-/]/gu, '')

const CODE_LANGS: Record<string, string> = { ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json', py: 'python', rs: 'rust', css: 'css', html: 'html', sh: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql', csv: 'csv', java: 'java', c: 'c', cpp: 'cpp', go: 'go' }

function body(item: BrainItem): string {
  if (item.kind === 'file' && item.file) {
    const ext = item.file.name.split('.').pop()?.toLowerCase() ?? ''
    if (['md', 'markdown', 'txt', ''].includes(ext)) return item.content
    const fence = item.content.includes('```') ? '~~~~' : '```'
    return `${fence}${CODE_LANGS[ext] ?? ''}\n${item.content}\n${fence}`
  }
  if (item.kind === 'web' && item.url) {
    const link = `[${itemTitle(item).replace(/[[\]]/g, '')}](${item.url})`
    return item.content.trim() ? `${link}\n\n${item.content}` : link
  }
  return item.content
}

/** Construit les fichiers du coffre. */
export function buildVault(items: BrainItem[], projects: Project[] = []): VaultFile[] {
  const names = fileNames(items)
  const byId = new Map(items.map((i) => [i.id, i]))
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name
  /** [[Titre]] → [[Nom de fichier|Titre]] quand le nom diffère. */
  const target = (title: string): string | undefined => {
    const found = findByTitle(items, title)
    return found ? names.get(found.id) : undefined
  }
  return items.map((item) => {
    const name = names.get(item.id) ?? 'Sans titre'
    const title = itemTitle(item)
    let text = body(item).replace(/\[\[([^\]\n|#]+)((?:#[^\]\n|]*)?)(?:\|([^\]\n]+))?\]\]/g, (all, t: string, anchor: string, alias?: string) => {
      const file = target(t)
      if (!file) return all
      const label = alias ?? t
      return file === label.trim() ? `[[${file}${anchor}]]` : `[[${file}${anchor}|${label}]]`
    })
    // Liens trouvés par le rangement, pas encore écrits dans le texte.
    const extra = (item.links ?? [])
      .flatMap((id) => (byId.has(id) ? [names.get(id) ?? ''] : []))
      .filter((n) => n && !text.includes(`[[${n}`))
    if (extra.length) text = `${text.trimEnd()}\n\n## Liens\n\n${extra.map((n) => `- [[${n}]]`).join('\n')}`

    const tags = item.tags.map(obsidianTag).filter(Boolean)
    const projectsOf = item.projectIds.map(projectName).filter((n): n is string => Boolean(n))
    const front = [
      '---',
      `title: ${yamlString(title)}`,
      ...(name !== title ? [`aliases:\n  - ${yamlString(title)}`] : []),
      `type: ${item.moc ? 'index' : item.kind}`,
      ...(tags.length ? [`tags:\n${tags.map((t) => `  - ${yamlString(t)}`).join('\n')}`] : []),
      `created: ${day(item.createdAt)}`,
      `updated: ${day(item.updatedAt)}`,
      ...(item.url ? [`source: ${yamlString(item.url)}`] : []),
      ...(projectsOf.length ? [`projets:\n${projectsOf.map((p) => `  - ${yamlString(p)}`).join('\n')}`] : []),
      `aery-id: ${yamlString(item.id)}`,
      '---',
    ].join('\n')
    return { path: `${item.folder ?? INBOX_FOLDER}/${name}.md`, content: `${front}\n\n${text.trim()}\n` }
  })
}

// --- Côté appli (Rust) -------------------------------------------------------------------------

export interface ExportReport {
  path: string
  written: number
  unchanged: number
  removed: number
  backedUp: number
}

export const CAN_EXPORT = IS_TAURI

/** Dossier d'export choisi (null = aucun). */
export function getVault(): Promise<string | null> {
  return IS_TAURI ? invokeCommand<string | null>('get_vault') : Promise.resolve(null)
}

/** Fenêtre « Choisir un dossier » de macOS. null = annulé. */
export function pickVault(): Promise<string | null> {
  return invokeCommand<string | null>('pick_vault')
}

export function forgetVault(): Promise<void> {
  return invokeCommand('forget_vault')
}

export function exportVault(items: BrainItem[], projects: Project[]): Promise<ExportReport> {
  return invokeCommand<ExportReport>('export_vault', { files: buildVault(items, projects) })
}
