import { Brain, Plus, Search, Upload, X } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { Appear } from '@/components/Appear'
import { BRAIN_KIND_ICONS } from '@/components/brain/kinds'
import { ProjectSources } from '@/components/ProjectSources'
import { ProjectIcon } from '@/components/ProjectIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Conversation } from '@/hooks/useChat'
import type { Brain as BrainState } from '@/hooks/useBrain'
import { AttachmentError, readAttachment, type Attachment } from '@/lib/attachments'
import { allTags, BRAIN_KIND_LABELS, itemTitle, plainText, searchBrain, type BrainItem, type BrainKind } from '@/lib/brain'
import { attachmentKey, normalizeUrl } from '@/lib/projectSources'
import type { Project } from '@/lib/projects'
import { cn } from '@/lib/utils'

const KINDS: BrainKind[] = ['note', 'reply', 'file', 'web']
/** Tags proposés en filtres (les plus utilisés). */
const TOP_TAGS = 12

const BRAIN_SOURCE_LABELS = {
  add: 'Garder',
  addTitle: 'Le garder dans le cerveau (le modèle pourra le retrouver)',
  known: 'Dans le cerveau',
}

/**
 * Accueil de l'espace Cerveau : une question à poser à ses notes, la recherche, les éléments
 * gardés (« Mes notes ») et ce qui est passé dans les conversations (« Capturé »).
 */
export function BrainHome({
  brain,
  projects,
  conversations,
  composer,
  widthClass,
  onOpen,
  onNew,
  onSelectConversation,
}: {
  brain: BrainState
  projects: Project[]
  conversations: Conversation[]
  /** Zone de saisie : la question part dans une conversation du Chat, avec la recherche dans le cerveau. */
  composer: ReactNode
  widthClass: string
  onOpen: (id: string) => void
  onNew: () => void
  onSelectConversation: (id: string) => void
}) {
  const { items } = brain
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<BrainKind | null>(null)
  const [tag, setTag] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const tags = useMemo(() => allTags(items).slice(0, TOP_TAGS), [items])
  const filtered = useMemo(() => {
    const base = items.filter((i) => (!kind || i.kind === kind) && (!tag || i.tags.includes(tag)))
    if (query.trim()) return searchBrain(base, query, 100)
    return [...base].sort((a, b) => b.updatedAt - a.updatedAt).map((item) => ({ item, snippet: '', score: 0 }))
  }, [items, kind, tag, query])

  const knownFiles = useMemo(() => new Set(items.flatMap((i) => (i.file ? [attachmentKey({ kind: 'text', ...i.file })] : []))), [items])
  const knownUrls = useMemo(() => new Set(items.flatMap((i) => (i.url ? [normalizeUrl(i.url)] : []))), [items])
  const projectName = (id: string) => projects.find((p) => p.id === id)

  async function importFiles(files: File[]) {
    setImportError(null)
    for (const file of files) {
      try {
        const a = await readAttachment(file)
        const { error } = brain.keepFile(a)
        if (error) setImportError(error)
      } catch (e) {
        setImportError(e instanceof AttachmentError ? e.message : `Impossible de lire « ${file.name} ».`)
      }
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Appear stagger={0.08} from={{ autoAlpha: 0, y: 20, duration: 0.5 }} className={cn('mx-auto flex w-full flex-col gap-6 px-4 pt-[8vh] pb-8', widthClass)}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
            <Brain className="size-6" aria-hidden />
          </span>
          <h2 className="text-2xl font-semibold sm:text-3xl">Ton second cerveau</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {items.length
              ? `${items.length} élément${items.length > 1 ? 's' : ''} gardé${items.length > 1 ? 's' : ''}. Pose une question : le modèle va chercher dans tes notes.`
              : 'Garde une réponse du chat (icône marque-page sous la réponse), écris une note ou importe des fichiers. Le modèle pourra ensuite y chercher.'}
          </p>
        </div>

        {items.length > 0 && composer}

        <Tabs defaultValue="mine">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TabsList>
              <TabsTrigger value="mine">
                Mes notes <span className="text-xs text-muted-foreground tabular-nums">{items.length}</span>
              </TabsTrigger>
              <TabsTrigger value="captured">Capturé</TabsTrigger>
            </TabsList>
            <div className="flex gap-2">
              <input
                ref={fileRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void importFiles([...(e.target.files ?? [])])
                  e.target.value = ''
                }}
              />
              <Button variant="outline" className="h-9" onClick={() => fileRef.current?.click()} title="Fichiers texte : notes, Markdown, code, CSV…">
                <Upload aria-hidden />
                Importer
              </Button>
              <Button className="h-9" onClick={onNew}>
                <Plus aria-hidden />
                Nouvelle note
              </Button>
            </div>
          </div>
          {importError && (
            <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              {importError}
            </p>
          )}

          <TabsContent value="mine" className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Chercher dans le cerveau…"
                aria-label="Chercher dans le cerveau"
                className="h-10 pl-9"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label="Effacer la recherche"
                  title="Effacer la recherche"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
                >
                  <X className="size-4" aria-hidden />
                </button>
              )}
            </div>

            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtres">
              <Chip on={kind === null} onClick={() => setKind(null)}>
                Tout
              </Chip>
              {KINDS.filter((k) => items.some((i) => i.kind === k)).map((k) => {
                const Icon = BRAIN_KIND_ICONS[k]
                return (
                  <Chip key={k} on={kind === k} onClick={() => setKind(kind === k ? null : k)}>
                    <Icon className="size-3.5" aria-hidden />
                    {BRAIN_KIND_LABELS[k]}
                  </Chip>
                )
              })}
              {tags.map(({ tag: t }) => (
                <Chip key={t} on={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                  #{t}
                </Chip>
              ))}
            </div>

            {filtered.length === 0 ? (
              <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
                {items.length === 0 ? 'Ton cerveau est vide pour l’instant.' : 'Rien ne correspond.'}
              </p>
            ) : (
              <ul aria-label="Éléments du cerveau" className="flex flex-col divide-y rounded-2xl border">
                {filtered.map(({ item, snippet }) => (
                  <ItemRow key={item.id} item={item} snippet={snippet} projectOf={projectName} onOpen={() => onOpen(item.id)} />
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="captured">
            <p className="mb-3 text-sm text-muted-foreground">
              Ce qui est passé dans tes conversations : fichiers envoyés et pages trouvées par la recherche web. Rien n’est gardé tant que tu ne le demandes pas.
            </p>
            <ProjectSources
              conversations={conversations}
              knownFiles={knownFiles}
              knownUrls={knownUrls}
              onSelect={onSelectConversation}
              onAddFile={(file: Attachment) => brain.keepFile(file).error ?? null}
              onKeepLink={brain.keepLink}
              labels={BRAIN_SOURCE_LABELS}
              title="Dans tes conversations"
              emptyText="Rien pour l’instant : les fichiers joints et les pages web trouvées apparaîtront ici."
            />
          </TabsContent>
        </Tabs>
      </Appear>
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        on ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  )
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' })

function ItemRow({
  item,
  snippet,
  projectOf,
  onOpen,
}: {
  item: BrainItem
  snippet: string
  projectOf: (id: string) => Project | undefined
  onOpen: () => void
}) {
  const Icon = BRAIN_KIND_ICONS[item.kind]
  const preview = snippet || item.url || plainText(item.content.slice(0, 400)).slice(0, 200)
  const linked = item.projectIds.map(projectOf).filter((p): p is Project => p !== undefined)
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full gap-3 px-4 py-3 text-left transition-colors outline-none first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/50 focus-visible:bg-muted/50"
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
          <span className="sr-only">{BRAIN_KIND_LABELS[item.kind]}</span>
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{itemTitle(item)}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{dateFormat.format(item.updatedAt)}</span>
          </span>
          {preview && <span className="line-clamp-2 text-sm text-muted-foreground">{preview}</span>}
          {(item.tags.length > 0 || linked.length > 0) && (
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              {linked.map((p) => (
                <span key={p.id} className="flex items-center gap-1">
                  <ProjectIcon project={p} className="size-3" />
                  {p.name}
                </span>
              ))}
              {item.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
            </span>
          )}
        </span>
      </button>
    </li>
  )
}
