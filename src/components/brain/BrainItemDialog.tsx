import { CircleAlert, ExternalLink, Eye, MessageSquare, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { BRAIN_KIND_ICONS } from '@/components/brain/kinds'
import { Markdown } from '@/components/Markdown'
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { projectRoomError } from '@/hooks/useBrain'
import { BRAIN_KIND_LABELS, BRAIN_LIMITS, itemTitle, parseTags, type BrainItem } from '@/lib/brain'
import type { Project } from '@/lib/projects'
import { cn } from '@/lib/utils'

export type BrainDraft = Pick<BrainItem, 'title' | 'content' | 'tags' | 'projectIds' | 'url'>

interface Props {
  /** null = nouvelle note. */
  item: BrainItem | null
  /** Tous les éléments (pour vérifier la place dans les projets). */
  items: BrainItem[]
  projects: Project[]
  /** La conversation d'origine existe encore (bouton « Ouvrir la conversation »). */
  canOpenOrigin: boolean
  onSave: (draft: BrainDraft) => void
  onDelete: () => void
  onOpenOrigin: () => void
  onClose: () => void
}

/** Lire / modifier un élément du cerveau : titre, tags, texte (Markdown), projets qui s'en servent. */
export function BrainItemDialog({ item, items, projects, canOpenOrigin, onSave, onDelete, onOpenOrigin, onClose }: Props) {
  const [title, setTitle] = useState(item?.title ?? '')
  const [tags, setTags] = useState(item?.tags.join(', ') ?? '')
  const [content, setContent] = useState(item?.content ?? '')
  const [url, setUrl] = useState(item?.url ?? '')
  const [projectIds, setProjectIds] = useState(item?.projectIds ?? [])
  // Un élément existant s'ouvre en lecture (Markdown rendu), une nouvelle note directement en écriture.
  const [preview, setPreview] = useState(item !== null && item.content.trim() !== '')
  const [projectError, setProjectError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const kind = item?.kind ?? 'note'
  const Icon = BRAIN_KIND_ICONS[kind]
  const canSave = Boolean(title.trim() || content.trim() || url.trim())
  const validUrl = !url.trim() || /^https?:\/\//i.test(url.trim())

  function toggleProject(project: Project) {
    setProjectError(null)
    if (projectIds.includes(project.id)) {
      setProjectIds(projectIds.filter((id) => id !== project.id))
      return
    }
    const error = projectRoomError(items, project.id, { id: item?.id ?? '', content, name: title.trim() || 'Cette note' })
    if (error) setProjectError(error)
    else setProjectIds([...projectIds, project.id])
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(46rem,calc(100dvh-7rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-5 pr-12">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <DialogTitle className="truncate text-base font-semibold">{item ? itemTitle(item) : 'Nouvelle note'}</DialogTitle>
          <DialogDescription className="sr-only">Titre, tags, contenu et projets de cet élément du cerveau.</DialogDescription>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">{BRAIN_KIND_LABELS[kind]}</span>
        </div>

        <form
          id="brain-form"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (!canSave || !validUrl) return
            onSave({ title, content, tags: parseTags(tags), projectIds, url: url.trim() || undefined })
          }}
        >
          <Input
            autoFocus={!item}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={BRAIN_LIMITS.title}
            placeholder="Titre (laisse vide : la première ligne servira de titre)"
            aria-label="Titre"
            className="h-10 text-base font-medium"
          />
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags séparés par des virgules : react, cours, idées…"
            aria-label="Tags"
            className="h-9"
          />
          {(kind === 'web' || item?.url) && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" aria-label="Adresse de la page" className="h-9" />
                {validUrl && url.trim() && (
                  <Button
                    variant="outline"
                    className="h-9"
                    render={<a href={url.trim()} target="_blank" rel="noopener noreferrer nofollow" />}
                    nativeButton={false}
                  >
                    <ExternalLink aria-hidden />
                    Ouvrir
                  </Button>
                )}
              </div>
              {!validUrl && <p className="text-xs text-destructive">L’adresse doit commencer par http:// ou https://.</p>}
            </div>
          )}

          <div className="flex min-h-64 flex-1 flex-col rounded-xl border">
            <div className="flex items-center gap-1 border-b px-2 py-1">
              <Button type="button" variant={preview ? 'ghost' : 'secondary'} size="sm" onClick={() => setPreview(false)} aria-pressed={!preview}>
                <Pencil aria-hidden />
                Écrire
              </Button>
              <Button type="button" variant={preview ? 'secondary' : 'ghost'} size="sm" onClick={() => setPreview(true)} aria-pressed={preview}>
                <Eye aria-hidden />
                Aperçu
              </Button>
              <span className="ml-auto pr-1 text-xs text-muted-foreground tabular-nums">
                {content.length.toLocaleString('fr-FR')} caractères · Markdown
              </span>
            </div>
            {preview ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {content.trim() ? <Markdown content={content} /> : <p className="text-sm text-muted-foreground">Rien à afficher.</p>}
              </div>
            ) : (
              <Textarea
                autoFocus={Boolean(item)}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                maxLength={BRAIN_LIMITS.content}
                placeholder="Écris ce que tu veux retenir… (Markdown accepté)"
                aria-label="Contenu"
                className="min-h-64 flex-1 resize-none rounded-none border-0 font-mono text-sm shadow-none focus-visible:ring-0"
              />
            )}
          </div>

          {projects.length > 0 && (
            <section aria-label="Projets">
              <h3 className="mb-1 text-sm font-medium">Projets qui s’en servent</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                Le modèle l’a sous les yeux dans toutes les conversations de ces projets (comme un fichier de référence).
              </p>
              <div className="flex flex-wrap gap-1.5">
                {projects.map((p) => {
                  const on = projectIds.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleProject(p)}
                      className={cn(
                        'flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                        on ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground hover:bg-muted',
                      )}
                    >
                      <ProjectIcon project={p} className="size-3.5" />
                      {p.name}
                    </button>
                  )
                })}
              </div>
              {projectError && (
                <p role="alert" className="mt-2 flex gap-1.5 text-xs text-destructive">
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                  {projectError}
                </p>
              )}
            </section>
          )}
        </form>

        <div className="flex shrink-0 items-center gap-2 border-t px-5 py-3">
          {item && (
            <Button type="button" variant="ghost" className="h-9 text-destructive hover:text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 aria-hidden />
              Supprimer
            </Button>
          )}
          {item?.origin && canOpenOrigin && (
            <Button type="button" variant="ghost" className="h-9" onClick={onOpenOrigin}>
              <MessageSquare aria-hidden />
              Conversation d’origine
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="ghost" className="h-9" onClick={onClose}>
              Annuler
            </Button>
            <Button type="submit" form="brain-form" className="h-9 px-4" disabled={!canSave || !validUrl}>
              {item ? 'Enregistrer' : 'Garder la note'}
            </Button>
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer du cerveau ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {item ? itemTitle(item) : ''} » sera supprimé définitivement
              {item && item.projectIds.length > 0 && ', et retiré des projets qui s’en servent'}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button variant="destructive" onClick={onDelete}>
              Supprimer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  )
}
