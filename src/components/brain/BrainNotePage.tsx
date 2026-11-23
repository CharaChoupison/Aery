import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  Check,
  CheckSquare,
  CircleAlert,
  Code,
  Copy,
  ExternalLink,
  Folder,
  FolderKanban,
  Heading2,
  History,
  Link2,
  List,
  ListChecks,
  LoaderCircle,
  Merge,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pencil,
  Plus,
  Quote,
  Table,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Appear } from '@/components/Appear'
import { DictationControls, DictationNotices } from '@/components/DictationControls'
import { BRAIN_KIND_ICONS } from '@/components/brain/kinds'
import { BrainHistoryDialog } from '@/components/brain/BrainHistoryDialog'
import { NoteAiBar, type NoteRange } from '@/components/brain/NoteAiBar'
import { Markdown, NoteLinkContext } from '@/components/Markdown'
import { ProjectIcon } from '@/components/ProjectIcon'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { projectRoomError, type Brain } from '@/hooks/useBrain'
import { useDictation } from '@/hooks/useDictation'
import {
  allFolders,
  BRAIN_KIND_LABELS,
  BRAIN_LIMITS,
  INBOX_FOLDER,
  itemTitle,
  linkifyWikilinks,
  PARA_FOLDERS,
  parseTags,
  relatedItems,
  sanitizeFolder,
  type BrainItem,
} from '@/lib/brain'
import { CAN_DICTATE, spliceDictation, type DictationBase } from '@/lib/dictation'
import type { Project } from '@/lib/projects'
import { cn } from '@/lib/utils'

/** Après le prochain rendu (pas requestAnimationFrame : il ne tourne pas quand la fenêtre est en arrière-plan). */
const afterRender = (fn: () => void) => setTimeout(fn, 0)

/** Délai avant l'enregistrement automatique (on attend une petite pause dans la frappe). */
const SAVE_DELAY = 600

type Draft = Pick<BrainItem, 'title' | 'content' | 'tags' | 'projectIds' | 'url' | 'folder'>

const draftOf = (i: BrainItem): Draft => ({ title: i.title, content: i.content, tags: i.tags, projectIds: i.projectIds, url: i.url, folder: i.folder })

/** Pastilles proposées sur une page vide : un petit modèle de départ. */
const TEMPLATES: { label: string; icon: LucideIcon; title: string; content: string }[] = [
  { label: 'Liste de tâches', icon: ListChecks, title: 'Liste de tâches', content: '- [ ] \n- [ ] \n- [ ] ' },
  { label: 'Notes de cours', icon: BookOpen, title: 'Cours : ', content: '## À retenir\n\n- \n\n## Détails\n\n\n\n## Questions\n\n- ' },
  { label: 'Point hebdomadaire', icon: CalendarDays, title: `Semaine du ${new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' })}`, content: '## Fait\n\n- \n\n## En cours\n\n- \n\n## À faire\n\n- [ ] ' },
  { label: 'Suivi de projet', icon: FolderKanban, title: 'Projet : ', content: '**Objectif :** \n\n**Échéance :** \n\n## Étapes\n\n- [ ] \n\n## Notes\n\n' },
]

/** Insertions de la barre d'outils (au curseur). `block` = sur une nouvelle ligne. */
const INSERTS: { label: string; icon: LucideIcon; text: string; block?: boolean; shortcut?: string }[] = [
  { label: 'Titre', icon: Heading2, text: '## ', block: true, shortcut: '##' },
  { label: 'Liste à puces', icon: List, text: '- ', block: true, shortcut: '-' },
  { label: 'Liste de tâches', icon: CheckSquare, text: '- [ ] ', block: true, shortcut: '[ ]' },
  { label: 'Citation', icon: Quote, text: '> ', block: true, shortcut: '>' },
  { label: 'Bloc de code', icon: Code, text: '```\n\n```', block: true, shortcut: '```' },
  { label: 'Tableau', icon: Table, text: '| Colonne | Colonne |\n| --- | --- |\n|  |  |', block: true },
  { label: 'Lien vers une note', icon: Link2, text: '[[', shortcut: '[[' },
]

/**
 * Une note du cerveau en pleine page, façon Notion : grand titre éditable, propriétés discrètes,
 * puis le texte (Markdown) sans cadre. Tout s'enregistre tout seul.
 */
export function BrainNotePage({
  item,
  brain,
  projects,
  canOpenOrigin,
  model,
  onBack,
  onOpenNote,
  onOpenOrigin,
}: {
  item: BrainItem
  brain: Brain
  projects: Project[]
  canOpenOrigin: boolean
  /** Modèle choisi dans l'en-tête, pour la barre « Demande à l'IA ». */
  model?: string
  onBack: () => void
  onOpenNote: (id: string) => void
  onOpenOrigin: () => void
}) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item))
  const [saving, setSaving] = useState<'idle' | 'pending' | 'saved'>('idle')
  // Une page avec du texte s'ouvre en lecture (Markdown rendu) ; une page vide directement en écriture.
  const [editing, setEditing] = useState(() => item.content.trim() === '')
  const [tagInput, setTagInput] = useState('')
  const [folderInput, setFolderInput] = useState(item.folder ?? '')
  const [folderError, setFolderError] = useState(false)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPatch = useRef<Partial<Draft>>({})
  const titleRef = useRef<HTMLTextAreaElement>(null)
  const contentRef = useRef<HTMLTextAreaElement>(null)
  /** On a cliqué dans le texte : sa sélection / son curseur comptent pour la barre IA. */
  const contentTouched = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const Icon = BRAIN_KIND_ICONS[item.kind]

  // --- Enregistrement automatique -------------------------------------------------------
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    const patch = pendingPatch.current
    pendingPatch.current = {}
    if (Object.keys(patch).length) {
      brain.update(item.id, patch)
      setSaving('saved')
    }
  }, [brain, item.id])

  const change = useCallback(
    (patch: Partial<Draft>) => {
      setDraft((d) => ({ ...d, ...patch }))
      pendingPatch.current = { ...pendingPatch.current, ...patch }
      setSaving('pending')
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, SAVE_DELAY)
    },
    [flush],
  )

  // En quittant la page : on enregistre ce qui reste. (Une page laissée vide est supprimée par App.)
  const flushRef = useRef(flush)
  useEffect(() => {
    flushRef.current = flush
  })
  useEffect(() => () => flushRef.current(), [])

  // Modifiée ailleurs (rangement, restauration d'une version) pendant qu'on ne tape pas : on recharge.
  const [seenUpdate, setSeenUpdate] = useState(item.updatedAt)
  if (item.updatedAt !== seenUpdate) {
    setSeenUpdate(item.updatedAt)
    if (!timer.current && saving !== 'pending' && (item.content !== draft.content || item.title !== draft.title || item.folder !== draft.folder || item.tags.join() !== draft.tags.join())) {
      setDraft(draftOf(item))
      setFolderInput(item.folder ?? '')
    }
  }

  // --- Hauteur automatique des zones de texte ------------------------------------------------
  useAutoHeight(titleRef, draft.title)
  useAutoHeight(contentRef, draft.content, editing)

  /** Insère un morceau de Markdown au curseur (en début de ligne pour les blocs). */
  function insert(text: string, block = false) {
    const el = contentRef.current
    const content = draft.content
    const start = el ? el.selectionStart : content.length
    const end = el ? el.selectionEnd : content.length
    const before = content.slice(0, start)
    const prefix = block && before && !before.endsWith('\n') ? '\n' : ''
    const next = before + prefix + text + content.slice(end)
    change({ content: next.slice(0, BRAIN_LIMITS.content) })
    setEditing(true)
    // Curseur juste après l'insertion (au milieu pour un bloc de code).
    const caret = start + prefix.length + (text.startsWith('```') ? 4 : text.length)
    afterRender(() => {
      const area = contentRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(caret, caret)
    })
  }

  // --- Dictée (appli seulement) : le texte s'écrit en direct dans la note -------------------
  // Au curseur si on a cliqué dans le texte, sinon dans un nouveau paragraphe à la fin.
  // Chaque texte reçu remplace le précédent ; Annuler remet la note comme avant.
  const dictationBase = useRef<(DictationBase & { paragraph: boolean }) | null>(null)
  const dictationCaret = useRef<number | null>(null)
  const dictation = useDictation((text) => {
    const base = dictationBase.current
    if (!base) return
    const { value, cursor } = spliceDictation(base, text && base.paragraph ? `\n\n${text}` : text)
    dictationCaret.current = Math.min(cursor, BRAIN_LIMITS.content)
    change({ content: value.slice(0, BRAIN_LIMITS.content) })
  })
  const dictating = dictation.phase !== 'idle'

  function startDictation() {
    const el = contentRef.current
    const content = draft.content
    const atCaret = editing && el !== null && contentTouched.current
    const start = atCaret ? el.selectionStart : content.length
    const end = atCaret ? el.selectionEnd : content.length
    const paragraph = !atCaret && content.trim() !== '' && !content.endsWith('\n')
    dictationBase.current = { text: content, start, end, paragraph }
    flush() // ce qui a été tapé avant est enregistré tel quel
    setEditing(true)
    void dictation.start()
  }

  // Dictée à la fin de la note : la page suit le texte qui s'écrit.
  useEffect(() => {
    const scroller = scrollRef.current
    const base = dictationBase.current
    if (dictating && scroller && base && base.start === base.text.length) scroller.scrollTop = scroller.scrollHeight
  }, [draft.content, dictating])

  // Fin de la dictée : curseur juste après le texte dicté.
  useEffect(() => {
    if (dictation.phase !== 'idle' || dictationCaret.current === null) return
    const caret = dictationCaret.current
    dictationCaret.current = null
    afterRender(() => {
      const area = contentRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(caret, caret)
      contentTouched.current = true
    })
  }, [dictation.phase])

  function addTags(raw: string) {
    const tags = parseTags([...draft.tags, ...parseTags(raw)].join(','))
    if (tags.join() !== draft.tags.join()) change({ tags })
    setTagInput('')
  }

  function commitFolder(raw: string) {
    const value = raw.trim()
    if (!value || value === INBOX_FOLDER) {
      setFolderError(false)
      setFolderInput('')
      if (draft.folder) change({ folder: undefined })
      return
    }
    const folder = sanitizeFolder(value)
    setFolderError(!folder)
    if (folder) {
      setFolderInput(folder)
      if (folder !== draft.folder) change({ folder })
    }
  }

  function toggleProject(project: Project) {
    setProjectError(null)
    if (draft.projectIds.includes(project.id)) {
      change({ projectIds: draft.projectIds.filter((id) => id !== project.id) })
      return
    }
    const error = projectRoomError(brain.items, project.id, { id: item.id, content: draft.content, name: draft.title.trim() || 'Cette note' })
    if (error) setProjectError(error)
    else change({ projectIds: [...draft.projectIds, project.id] })
  }

  /** Sélection ou curseur dans le texte (seulement en écriture et si on y a cliqué). */
  const getRange = useCallback((): NoteRange | null => {
    const el = contentRef.current
    if (!el || !contentTouched.current) return null
    return { start: el.selectionStart, end: el.selectionEnd }
  }, [])

  /** Texte de l'IA appliqué : enregistré tout de suite, curseur placé juste après. */
  function applyAi(content: string, caret: number) {
    change({ content })
    flush()
    if (!editing) return
    afterRender(() => {
      const area = contentRef.current
      if (!area) return
      area.focus()
      area.setSelectionRange(caret, caret)
    })
  }

  /** Doublon possible : la note ressemblante (si elle existe encore). */
  const twin = item.duplicateOf ? brain.items.find((i) => i.id === item.duplicateOf?.of) : undefined

  async function mergeIntoTwin() {
    flush() // ce qui vient d'être tapé part aussi dans la fusion
    setMerging(true)
    setMergeError(null)
    const { targetId, error } = await brain.mergeDuplicate(item.id)
    setMerging(false)
    if (targetId) onOpenNote(targetId)
    else setMergeError(error ?? 'La fusion a échoué.')
  }

  const folders = useMemo(() => [...new Set([...PARA_FOLDERS, ...allFolders(brain.items)])].sort((a, b) => a.localeCompare(b, 'fr')), [brain.items])
  const related = useMemo(() => relatedItems({ ...item, content: draft.content }, brain.items), [item, draft.content, brain.items])
  const rendered = useMemo(() => linkifyWikilinks(draft.content, brain.items), [draft.content, brain.items])
  const validUrl = !draft.url?.trim() || /^https?:\/\//i.test(draft.url.trim())
  const empty = !draft.content.trim()
  const dateFormat = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Barre d'outils : retour, type de page, insertions, état de l'enregistrement, menu. */}
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <ToolButton label="Retour au cerveau" onClick={onBack}>
          <ArrowLeft aria-hidden />
        </ToolButton>
        <span className="flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm text-muted-foreground">
          <Icon className="size-3.5" aria-hidden />
          {item.moc ? 'Index' : BRAIN_KIND_LABELS[item.kind]}
        </span>
        <div className="mx-1 flex items-center rounded-full border p-0.5" role="toolbar" aria-label="Insérer">
          {INSERTS.slice(0, 3).map((i) => (
            <ToolButton key={i.label} label={i.label} onClick={() => insert(i.text, i.block)} small>
              <i.icon aria-hidden />
            </ToolButton>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Insérer un bloc" title="Insérer un bloc" />}>
              <Plus aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-auto min-w-56">
              {INSERTS.map((i) => (
                <DropdownMenuItem key={i.label} onClick={() => insert(i.text, i.block)}>
                  <i.icon aria-hidden />
                  {i.label}
                  {i.shortcut && <DropdownMenuShortcut>{i.shortcut}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {CAN_DICTATE && (
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full"
            onClick={startDictation}
            disabled={dictating}
            aria-label="Dicter dans la note (transcrit sur ton Mac)"
            title="Dicter dans la note (transcrit sur ton Mac)"
          >
            <Mic aria-hidden />
          </Button>
        )}

        <div className="ml-auto flex items-center gap-1">
          <span className="mr-1 flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
            {saving === 'pending' ? (
              <>
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
                Enregistrement…
              </>
            ) : saving === 'saved' ? (
              <>
                <Check className="size-3" aria-hidden />
                Enregistré
              </>
            ) : null}
          </span>
          <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setEditing(!editing)} aria-pressed={editing} disabled={dictating}>
            {editing ? <BookOpen aria-hidden /> : <Pencil aria-hidden />}
            {editing ? 'Lire' : 'Écrire'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Plus d’options" title="Plus d’options" />}>
              <MoreHorizontal aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-56">
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History aria-hidden />
                Versions précédentes
              </DropdownMenuItem>
              {item.origin && canOpenOrigin && (
                <DropdownMenuItem onClick={onOpenOrigin}>
                  <MessageSquare aria-hidden />
                  Conversation d’origine
                </DropdownMenuItem>
              )}
              {draft.url && validUrl && (
                <DropdownMenuItem render={<a href={draft.url} target="_blank" rel="noopener noreferrer nofollow" />}>
                  <ExternalLink aria-hidden />
                  Ouvrir la page web
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                <Trash2 aria-hidden />
                Supprimer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <Appear from={{ autoAlpha: 0, y: 12, duration: 0.4 }} className="mx-auto flex w-full max-w-3xl flex-col px-6 pt-10 pb-32 sm:px-12">
          {twin && (
            <div role="status" className="mb-6 flex flex-col gap-3 rounded-xl border bg-muted/40 p-4 text-sm sm:flex-row sm:items-center">
              <Copy className="hidden size-4 shrink-0 text-muted-foreground sm:block" aria-hidden />
              <div className="min-w-0 flex-1">
                <p>
                  Ressemble à{' '}
                  <button type="button" onClick={() => onOpenNote(twin.id)} className="font-medium underline underline-offset-2 hover:text-foreground">
                    {itemTitle(twin)}
                  </button>
                </p>
                <p className="text-muted-foreground">{item.duplicateOf?.reason}</p>
                {mergeError && <p className="mt-1 text-destructive">{mergeError}</p>}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" className="rounded-full" onClick={() => void mergeIntoTwin()} disabled={merging || dictating}>
                  {merging ? <LoaderCircle className="animate-spin" aria-hidden /> : <Merge aria-hidden />}
                  Fusionner
                </Button>
                <Button size="sm" variant="ghost" className="rounded-full" onClick={() => brain.dismissDuplicate(item.id)} disabled={merging}>
                  Garder les deux
                </Button>
              </div>
            </div>
          )}
          <textarea
            ref={titleRef}
            rows={1}
            value={draft.title}
            onChange={(e) => change({ title: e.target.value.replace(/\n/g, ' ').slice(0, BRAIN_LIMITS.title) })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                setEditing(true)
                afterRender(() => contentRef.current?.focus())
              }
            }}
            autoFocus={!item.title && empty}
            placeholder="Page sans titre"
            aria-label="Titre"
            className="w-full resize-none overflow-hidden bg-transparent text-4xl leading-tight font-bold tracking-tight outline-none placeholder:text-muted-foreground/50"
          />

          {/* Propriétés : discrètes, comme dans Notion. */}
          <dl className="mt-5 flex flex-col gap-0.5 text-sm">
            <Property icon={Tag} label="Tags">
              <div className="flex flex-wrap items-center gap-1">
                {draft.tags.map((t) => (
                  <span key={t} className="flex h-6 items-center gap-0.5 rounded-md bg-muted pr-0.5 pl-2 text-xs">
                    #{t}
                    <button
                      type="button"
                      onClick={() => change({ tags: draft.tags.filter((x) => x !== t) })}
                      aria-label={`Retirer le tag ${t}`}
                      title={`Retirer le tag ${t}`}
                      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </span>
                ))}
                <input
                  value={tagInput}
                  onChange={(e) => (e.target.value.includes(',') ? addTags(e.target.value) : setTagInput(e.target.value))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addTags(tagInput)
                    } else if (e.key === 'Backspace' && !tagInput && draft.tags.length) {
                      change({ tags: draft.tags.slice(0, -1) })
                    }
                  }}
                  onBlur={() => tagInput && addTags(tagInput)}
                  placeholder={draft.tags.length ? 'Ajouter' : 'Vide'}
                  aria-label="Ajouter un tag"
                  className="h-6 min-w-16 flex-1 bg-transparent px-1 outline-none placeholder:text-muted-foreground/60"
                />
              </div>
            </Property>
            <Property icon={Folder} label="Dossier">
              <input
                value={folderInput}
                list="brain-folders"
                onChange={(e) => setFolderInput(e.target.value)}
                onBlur={(e) => commitFolder(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                placeholder={INBOX_FOLDER}
                aria-label="Dossier"
                className="h-6 w-full bg-transparent px-1 outline-none placeholder:text-muted-foreground/60"
              />
              <datalist id="brain-folders">
                {folders.map((f) => (
                  <option key={f} value={f} />
                ))}
              </datalist>
              {folderError && (
                <p className="px-1 text-xs text-destructive">
                  Commence par un dossier PARA : {PARA_FOLDERS.join(', ')} (puis « /sous-dossier » si tu veux).
                </p>
              )}
            </Property>
            {(item.kind === 'web' || draft.url) && (
              <Property icon={ExternalLink} label="Adresse">
                <input
                  value={draft.url ?? ''}
                  onChange={(e) => change({ url: e.target.value || undefined })}
                  placeholder="https://…"
                  aria-label="Adresse de la page"
                  className="h-6 w-full bg-transparent px-1 outline-none placeholder:text-muted-foreground/60"
                />
                {!validUrl && <p className="px-1 text-xs text-destructive">L’adresse doit commencer par http:// ou https://.</p>}
              </Property>
            )}
            {projects.length > 0 && (
              <Property icon={FolderKanban} label="Projets" hint="Le modèle a cette note sous les yeux dans toutes les conversations de ces projets.">
                <div className="flex flex-wrap gap-1">
                  {projects.map((p) => {
                    const on = draft.projectIds.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleProject(p)}
                        className={cn(
                          'flex h-6 items-center gap-1 rounded-md px-2 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                          on ? 'bg-primary/10 text-foreground ring-1 ring-primary/40' : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        <ProjectIcon project={p} className="size-3" />
                        {p.name}
                      </button>
                    )
                  })}
                </div>
                {projectError && (
                  <p role="alert" className="mt-1 flex gap-1.5 px-1 text-xs text-destructive">
                    <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                    {projectError}
                  </p>
                )}
              </Property>
            )}
            {(related.out.length > 0 || related.back.length > 0) && (
              <Property icon={Link2} label="Liens">
                <div className="flex flex-wrap gap-1">
                  {[...related.out, ...related.back].map((r) => {
                    const RIcon = BRAIN_KIND_ICONS[r.kind]
                    return (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => onOpenNote(r.id)}
                        title={related.back.includes(r) ? 'Cette note mentionne la page' : 'Note liée'}
                        className="flex h-6 max-w-56 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <RIcon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{itemTitle(r)}</span>
                      </button>
                    )
                  })}
                </div>
              </Property>
            )}
          </dl>
          <p className="mt-2 px-0.5 text-xs text-muted-foreground/70">
            Modifiée le {dateFormat.format(item.updatedAt)}
            {item.tidiedAt && item.tidiedAt >= item.updatedAt - 1000 ? ' · rangée automatiquement' : ''}
          </p>

          <hr className="my-6" />

          {editing && empty && !dictating && (
            <div className="mb-4 flex flex-wrap gap-2" aria-label="Modèles de page">
              {TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  onClick={() => {
                    change({ content: t.content, ...(!draft.title.trim() && { title: t.title }) })
                    afterRender(() => {
                      contentRef.current?.focus()
                      contentRef.current?.setSelectionRange(t.content.indexOf(' ') + 1, t.content.indexOf(' ') + 1)
                    })
                  }}
                  className="flex h-9 items-center gap-2 rounded-full border px-4 text-sm transition-colors hover:bg-muted"
                >
                  <t.icon className="size-4 text-muted-foreground" aria-hidden />
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {editing ? (
            <textarea
              ref={contentRef}
              value={draft.content}
              onChange={(e) => change({ content: e.target.value.slice(0, BRAIN_LIMITS.content) })}
              readOnly={dictating}
              onBlur={flush}
              onFocus={() => (contentTouched.current = true)}
              autoFocus={Boolean(item.title) && empty}
              placeholder={dictating ? 'Parle, le texte s’écrit ici…' : 'Écris ici, ou choisis un modèle. Markdown accepté, [[Titre]] pour lier une autre note.'}
              aria-label="Contenu"
              className="min-h-[40vh] w-full resize-none overflow-hidden bg-transparent text-base leading-7 outline-none placeholder:text-muted-foreground/60"
            />
          ) : (
            // Lecture : un clic dans le texte (hors lien) passe en écriture.
            <div
              className="min-h-[40vh] cursor-text"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('a, button')) setEditing(true)
              }}
            >
              {empty ? (
                <p className="text-muted-foreground/60">Page vide. Clique pour écrire.</p>
              ) : (
                <NoteLinkContext.Provider value={onOpenNote}>
                  <Markdown content={rendered} />
                </NoteLinkContext.Provider>
              )}
            </div>
          )}
        </Appear>
      </div>

      {/* Dictée : pastille flottante au-dessus de la barre IA (ondes, Annuler, Terminer), ou son message. */}
      {CAN_DICTATE && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-10 flex justify-center px-4">
          {dictating ? (
            <Appear from={{ autoAlpha: 0, y: 8, duration: 0.25 }} className="pointer-events-auto w-full max-w-md rounded-full border bg-background p-1.5 shadow-lg">
              <DictationControls dictation={dictation} />
            </Appear>
          ) : (
            <DictationNotices dictation={dictation} className="pointer-events-auto max-w-xl rounded-2xl border bg-background px-4 py-2 shadow-sm" />
          )}
        </div>
      )}

      <NoteAiBar title={draft.title} content={draft.content} model={model} getRange={getRange} onApply={applyAi} />

      {historyOpen && <BrainHistoryDialog item={item} onRestore={brain.restore} onClose={() => setHistoryOpen(false)} />}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer du cerveau ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {itemTitle({ ...item, ...draft })} » sera supprimé définitivement
              {draft.projectIds.length > 0 && ', et retiré des projets qui s’en servent'}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (timer.current) clearTimeout(timer.current)
                timer.current = null
                pendingPatch.current = {}
                brain.remove(item.id)
                onBack()
              }}
            >
              Supprimer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** Une ligne de propriété : icône + libellé à gauche, valeur à droite. */
function Property({ icon: PIcon, label, hint, children }: { icon: LucideIcon; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] items-start gap-2 rounded-md py-0.5">
      <dt className="flex h-6 items-center gap-2 text-muted-foreground" title={hint}>
        <PIcon className="size-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function ToolButton({ label, onClick, small, children }: { label: string; onClick: () => void; small?: boolean; children: ReactNode }) {
  return (
    <Button variant="ghost" size={small ? 'icon-sm' : 'icon'} className="rounded-full" onClick={onClick} aria-label={label} title={label}>
      {children}
    </Button>
  )
}

/** La zone de texte grandit avec son contenu (la page défile, pas la zone). */
function useAutoHeight(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, active = true) {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !active) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [ref, value, active])
}
