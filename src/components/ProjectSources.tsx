import { Check, FileText, Globe, ImageIcon, Plus, Quote } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Conversation } from '@/hooks/useChat'
import { formatSize, type Attachment } from '@/lib/attachments'
import { collectProjectSources, type DocumentSource, type LinkSource } from '@/lib/projectSources'
import type { Project } from '@/lib/projects'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** Nombre de lignes affichées avant « Tout afficher ». */
const PREVIEW = 6

/**
 * Sources du projet (accueil du projet) : documents envoyés et pages web trouvées
 * dans ses conversations. Un document texte peut être ajouté aux fichiers de référence du projet.
 */
export function ProjectSources({
  project,
  conversations,
  onSelect,
  onAddFile,
}: {
  project: Project
  conversations: Conversation[]
  onSelect: (conversationId: string) => void
  /** Ajoute le fichier au projet. Renvoie un message d'erreur si ce n'est pas possible (limites). */
  onAddFile: (file: Attachment) => string | null
}) {
  const sources = useMemo(() => collectProjectSources(project, conversations), [project, conversations])
  const [error, setError] = useState<string | null>(null)
  const { documents, links } = sources
  if (documents.length === 0 && links.length === 0) return null

  return (
    <section aria-label="Sources du projet">
      <Tabs defaultValue={documents.length > 0 ? 'documents' : 'links'}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">Sources</h3>
          <TabsList>
            <TabsTrigger value="documents" disabled={documents.length === 0}>
              Documents <Count n={documents.length} />
            </TabsTrigger>
            <TabsTrigger value="links" disabled={links.length === 0}>
              Pages web <Count n={links.length} />
            </TabsTrigger>
          </TabsList>
        </div>
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <TabsContent value="documents">
          <ShowMore items={documents} label="documents">
            {(d) => (
              <DocumentRow
                key={d.key}
                source={d}
                onOpen={() => onSelect(d.conversationId)}
                onAdd={() => setError(onAddFile(d.attachment))}
              />
            )}
          </ShowMore>
        </TabsContent>
        <TabsContent value="links">
          <ShowMore items={links} label="pages">
            {(l) => <LinkRow key={l.url} source={l} />}
          </ShowMore>
        </TabsContent>
      </Tabs>
    </section>
  )
}

function Count({ n }: { n: number }) {
  return <span className="text-xs text-muted-foreground tabular-nums">{n}</span>
}

/** Liste encadrée, limitée à PREVIEW lignes tant qu'on n'a pas cliqué sur « Tout afficher ». */
function ShowMore<T>({ items, label, children }: { items: T[]; label: string; children: (item: T) => ReactNode }) {
  const [all, setAll] = useState(false)
  const shown = all ? items : items.slice(0, PREVIEW)
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col divide-y rounded-2xl border">{shown.map(children)}</ul>
      {items.length > PREVIEW && (
        <Button variant="ghost" size="sm" className="self-center text-muted-foreground" onClick={() => setAll((v) => !v)}>
          {all ? 'Afficher moins' : `Tout afficher (${items.length} ${label})`}
        </Button>
      )}
    </div>
  )
}

const rowClass = 'flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50'

function DocumentRow({ source, onOpen, onAdd }: { source: DocumentSource; onOpen: () => void; onAdd: () => void }) {
  const a = source.attachment
  const Icon = a.kind === 'image' ? ImageIcon : FileText
  return (
    <li className="flex items-center first:rounded-t-2xl last:rounded-b-2xl [&:first-child>button]:rounded-tl-2xl [&:last-child>button]:rounded-bl-2xl">
      <button type="button" onClick={onOpen} className={rowClass} title={`Ouvrir « ${source.conversationTitle} »`}>
        {a.kind === 'image' && a.dataUrl ? (
          <img src={a.dataUrl} alt="" className="size-8 shrink-0 rounded-md border object-cover" />
        ) : (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            <Icon className="size-4 text-muted-foreground" aria-hidden />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{a.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {formatSize(a.size)} · {source.conversationTitle}
          </span>
        </span>
      </button>
      {a.kind === 'text' && (
        <div className="shrink-0 pr-3">
          {source.inProject ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden />
              Dans le projet
            </span>
          ) : (
            <Button variant="outline" size="sm" onClick={onAdd} title="Le modèle l’aura sous les yeux dans toutes les conversations du projet">
              <Plus aria-hidden />
              Ajouter au projet
            </Button>
          )}
        </div>
      )}
    </li>
  )
}

function LinkRow({ source }: { source: LinkSource }) {
  return (
    <li className="flex first:rounded-t-2xl last:rounded-b-2xl [&:first-child>a]:rounded-t-2xl [&:last-child>a]:rounded-b-2xl">
      <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" title={source.url} className={rowClass}>
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Globe className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <span className="truncate">{source.title}</span>
            {source.cited && (
              <span title="Citée dans une réponse" className="shrink-0">
                <Quote className="size-3 text-muted-foreground" aria-hidden />
                <span className="sr-only">(citée dans une réponse)</span>
              </span>
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {source.host} · {source.conversationTitle}
          </span>
        </span>
      </a>
    </li>
  )
}
