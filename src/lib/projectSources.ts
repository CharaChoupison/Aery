import type { Conversation } from '@/hooks/useChat'
import type { Attachment } from './attachments'
import type { Project } from './projects'

/**
 * Sources d'un projet : tout ce qui a servi dans ses conversations, retrouvé dans l'historique
 * (rien de plus n'est stocké) :
 *  - les documents envoyés (pièces jointes des messages) ;
 *  - les pages web trouvées par la recherche web (`step.sources`), celles citées dans la réponse en premier.
 * Un même document ou une même page utilisés plusieurs fois n'apparaissent qu'une fois (le plus récent).
 */

/** Où une source a été utilisée, pour pouvoir y retourner. */
interface Origin {
  conversationId: string
  conversationTitle: string
  /** Date de la conversation (on trie du plus récent au plus ancien). */
  at: number
}

export interface DocumentSource extends Origin {
  key: string
  attachment: Attachment
  /** Déjà dans les fichiers de référence du projet. */
  inProject: boolean
}

export interface LinkSource extends Origin {
  url: string
  title: string
  host: string
  /** Lien repris dans une réponse (et pas seulement trouvé par la recherche). */
  cited: boolean
}

export interface ProjectSources {
  documents: DocumentSource[]
  links: LinkSource[]
}

/** Un fichier est « le même » s'il a le même nom, le même type et la même taille. */
export const attachmentKey = (a: Pick<Attachment, 'kind' | 'name' | 'size'>) => `${a.kind}:${a.name}:${a.size}`

/** On ignore le #fragment et le / final : ce sont les mêmes pages. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href.replace(/\/$/, '')
  } catch {
    return url
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function collectProjectSources(project: Project, conversations: Conversation[]): ProjectSources {
  const projectFiles = new Set(project.files.map(attachmentKey))
  const documents = new Map<string, DocumentSource>()
  const links = new Map<string, LinkSource>()

  // Du plus récent au plus ancien : la première fois qu'on croise une source, c'est sa dernière utilisation.
  const sorted = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  for (const c of sorted) {
    const origin: Origin = { conversationId: c.id, conversationTitle: c.title, at: c.updatedAt }
    for (const m of c.messages) {
      for (const a of m.attachments ?? []) {
        const key = attachmentKey(a)
        if (!documents.has(key)) documents.set(key, { ...origin, key, attachment: a, inProject: projectFiles.has(key) })
      }
      for (const step of m.steps ?? []) {
        if (step.type !== 'tool' || !step.sources) continue
        for (const s of step.sources) {
          if (!/^https?:\/\//i.test(s.url)) continue // jamais de javascript:, data:…
          const url = normalizeUrl(s.url)
          const cited = m.content.includes(url)
          const known = links.get(url)
          if (!known) links.set(url, { ...origin, url: s.url, title: s.title.trim() || hostOf(s.url) || s.url, host: hostOf(s.url), cited })
          else if (cited && !known.cited) known.cited = true
        }
      }
    }
  }

  return {
    documents: [...documents.values()],
    // Citées d'abord, puis les simples résultats ; chaque groupe reste du plus récent au plus ancien.
    links: [...links.values()].sort((a, b) => Number(b.cited) - Number(a.cited)),
  }
}
