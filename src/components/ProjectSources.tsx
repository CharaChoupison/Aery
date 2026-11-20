import { Check, FileText, Globe, ImageIcon, Plus, Quote } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import type { Conversation } from '@/hooks/useChat'
import { formatSize, type Attachment } from '@/lib/attachments'
import { collectSources, type DocumentSource, type LinkSource } from '@/lib/projectSources'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

/** Nombre de lignes affichées avant « Tout afficher ». */
const PREVIEW = 6

/** Textes des boutons : « Ajouter au projet » (accueil d'un projet) ou « Garder » (cerveau). */
export interface SourceLabels {
  add: string
  addTitle: string
  known: string
}

const PROJECT_SOURCE_LABELS: SourceLabels = {
  add: 'Ajouter au projet',
  addTitle: 'Le modèle l’aura sous les yeux dans toutes les conversations du projet',
  known: 'Dans le projet',
}

/**
 * Sources (accueil d'un projet, ou onglet « Capturé » du cerveau) : documents envoyés et pages web
 * trouvées dans les conversations. Un document texte (et, dans le cerveau, une page) peut être gardé.
 */
export function ProjectSources({
  conversations,
  knownFiles,
  knownUrls,
  onSelect,
  onAddFile,
  onKeepLink,
  labels = PROJECT_SOURCE_LABELS,
  title = 'Sources',
  emptyText,
}: {
  conversations: Conversation[]
  /** Clés (attachmentKey) des fichiers déjà gardés. */
  knownFiles: Set<string>
  /** URL (normalizeUrl) des pages déjà gardées. */
  knownUrls?: Set<string>
  onSelect: (conversationId: string) => void
  /** Garde le fichier. Renvoie un message d'erreur si ce n'est pas possible (limites). */
  onAddFile: (file: Attachment) => string | null
  /** Garde la page web (absent = pas de bouton). */
  onKeepLink?: (link: { url: string; title: string }) => void
  labels?: SourceLabels
  title?: string
  /** Texte affiché s'il n'y a rien (absent = la section disparaît). */
  emptyText?: string
}) {
  const sources = useMemo(() => collectSources(conversations, knownFiles, knownUrls), [conversations, knownFiles, knownUrls])
  const [error, setError] = useState<string | null>(null)
  const { documents, links } = sources
  if (documents.length === 0 && links.length === 0) {
    return emptyText ? <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">{emptyText}</p> : null
  }

  return (
    <section aria-label={title}>
      <Tabs defaultValue={documents.length > 0 ? 'documents' : 'links'}>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
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
                labels={labels}
              />
            )}
          </ShowMore>
        </TabsContent>
        <TabsContent value="links">
          <ShowMore items={links} label="pages">
            {(l) => <LinkRow key={l.url} source={l} labels={labels} onKeep={onKeepLink && (() => onKeepLink({ url: l.url, title: l.title }))} />}
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

function DocumentRow({ source, onOpen, onAdd, labels }: { source: DocumentSource; onOpen: () => void; onAdd: () => void; labels: SourceLabels }) {
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
          <KeepButton known={source.known} onKeep={onAdd} labels={labels} />
        </div>
      )}
    </li>
  )
}

function KeepButton({ known, onKeep, labels }: { known: boolean; onKeep: () => void; labels: SourceLabels }) {
  return known ? (
    <span className="flex items-center gap-1 text-xs text-muted-foreground">
      <Check className="size-3.5" aria-hidden />
      {labels.known}
    </span>
  ) : (
    <Button variant="outline" size="sm" onClick={onKeep} title={labels.addTitle}>
      <Plus aria-hidden />
      {labels.add}
    </Button>
  )
}

function LinkRow({ source, labels, onKeep }: { source: LinkSource; labels: SourceLabels; onKeep?: () => void }) {
  return (
    <li className="flex items-center first:rounded-t-2xl last:rounded-b-2xl [&:first-child>a]:rounded-tl-2xl [&:last-child>a]:rounded-bl-2xl">
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
      {onKeep && (
        <div className="shrink-0 pr-3">
          <KeepButton known={source.known} onKeep={onKeep} labels={labels} />
        </div>
      )}
    </li>
  )
}
