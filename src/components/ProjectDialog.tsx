import { Ban, Brain, Check, CircleAlert, FileText, FolderCode, FolderPlus, Paperclip, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { defaultProjectIcon, PROJECT_ICONS, ProjectIcon } from '@/components/ProjectIcon'
import { Group, Row } from '@/components/settings/layout'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { Conversation } from '@/hooks/useChat'
import { AttachmentError, formatSize, readAttachment, type Attachment } from '@/lib/attachments'
import { folderName, pickWorkspace } from '@/lib/agent/tools'
import { filesChars, PROJECT_COLOR_LABELS, PROJECT_COLORS, PROJECT_LIMITS, projectColor, projectSpace, type Project, type ProjectColor, type Space } from '@/lib/projects'
import { cn } from '@/lib/utils'
import { IS_TAURI } from '@/lib/transport'

/** `files` : fichiers de référence, rangés dans le second cerveau à l'enregistrement. */
export type ProjectDraft = Pick<Project, 'name' | 'instructions' | 'memory' | 'workspace' | 'icon' | 'color'> & { files: Attachment[] }

interface Props {
  /** null = création d'un nouveau projet. */
  project: Project | null
  /** Espace du projet créé (pour un projet existant, on prend le sien). */
  space?: Space
  conversations: Conversation[]
  /** Fichiers de référence actuels du projet (éléments du cerveau). */
  files: Attachment[]
  onSave: (draft: ProjectDraft) => void
  onClose: () => void
  onForgetSummary: (conversationId: string) => void
}

/** Création / modification d'un projet : nom, instructions, fichiers de référence, mémoire. */
export function ProjectDialog({ project, space = 'chat', conversations, files, onSave, onClose, onForgetSummary }: Props) {
  const isCode = (project ? projectSpace(project) : space) === 'code'
  const [draft, setDraft] = useState<ProjectDraft>(() => ({
    name: project?.name ?? '',
    instructions: project?.instructions ?? '',
    files,
    memory: project?.memory ?? true,
    workspace: project?.workspace,
    icon: project?.icon && PROJECT_ICONS[project.icon] ? project.icon : undefined,
    color: projectColor(project ?? undefined),
  }))
  const [folderError, setFolderError] = useState<string | null>(null)

  /** Fenêtre « Choisir un dossier » de macOS : le chemin est vérifié et autorisé côté Rust. */
  async function chooseFolder() {
    setFolderError(null)
    try {
      const workspace = await pickWorkspace()
      if (workspace) setDraft((d) => ({ ...d, workspace, name: d.name.trim() ? d.name : folderName(workspace) }))
    } catch (e) {
      setFolderError((e as Error).message)
    }
  }
  const [fileError, setFileError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const update = (patch: Partial<ProjectDraft>) => setDraft((d) => ({ ...d, ...patch }))

  const used = filesChars(draft.files)
  const remembered = project ? conversations.filter((c) => c.projectId === project.id && c.summary) : []

  async function addFiles(files: File[]) {
    setFileError(null)
    const added: Attachment[] = []
    let total = used
    for (const file of files) {
      try {
        const a = await readAttachment(file)
        if (a.kind !== 'text') throw new AttachmentError(`« ${a.name} » : seuls les fichiers texte vont dans un projet (pas les images).`)
        if (draft.files.length + added.length >= PROJECT_LIMITS.files) throw new AttachmentError(`${PROJECT_LIMITS.files} fichiers maximum par projet.`)
        if (total + (a.text?.length ?? 0) > PROJECT_LIMITS.filesChars)
          throw new AttachmentError(`« ${a.name} » dépasse la place restante : les fichiers sont envoyés à chaque message, et les modèles gratuits ont peu de contexte.`)
        total += a.text?.length ?? 0
        added.push(a)
      } catch (e) {
        setFileError(e instanceof AttachmentError ? e.message : `Impossible de lire « ${file.name} ».`)
      }
    }
    if (added.length) setDraft((d) => ({ ...d, files: [...d.files, ...added] }))
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(44rem,calc(100dvh-7rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <DialogTitle className="text-base font-semibold">
            {project ? (isCode ? 'Modifier le projet de code' : 'Modifier le projet') : isCode ? 'Nouveau projet de code' : 'Nouveau projet'}
          </DialogTitle>
          <DialogDescription className="sr-only">Nom, instructions, fichiers de référence et mémoire du projet.</DialogDescription>
        </div>

        <form
          id="project-form"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.name.trim()) onSave({ ...draft, name: draft.name.trim() })
          }}
        >
          <Group title="Projet">
            <Row label="Nom">
              <Input
                autoFocus
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                maxLength={PROJECT_LIMITS.name}
                placeholder="Ex. : Appli Aery, Révisions de maths…"
                aria-label="Nom du projet"
                className="h-9"
              />
            </Row>
            <Row
              label="Icône et couleur"
              description="Pour repérer le projet d’un coup d’œil dans la barre latérale."
              control={
                <span className="flex size-10 items-center justify-center rounded-xl border bg-muted/40">
                  <ProjectIcon project={{ ...draft, space: isCode ? 'code' : 'chat' }} className="size-5" />
                </span>
              }
            >
              <IconPicker
                isCode={isCode}
                icon={draft.icon}
                color={draft.color}
                onIcon={(icon) => update({ icon })}
                onColor={(color) => update({ color })}
              />
            </Row>
            {isCode && (
              <Row
                label="Dossier"
                description={
                  IS_TAURI
                    ? 'L’agent peut lister, lire et chercher dans ce dossier (lecture seule). Les secrets (.env, clés) et node_modules sont exclus.'
                    : 'La lecture de fichiers passe par l’appli Aery : ici, l’agent n’a que JavaScript.'
                }
                control={
                  IS_TAURI && (
                    <Button type="button" variant="outline" className="h-9" onClick={() => void chooseFolder()}>
                      <FolderCode aria-hidden />
                      {draft.workspace ? 'Changer' : 'Choisir'}
                    </Button>
                  )
                }
              >
                {draft.workspace && (
                  <p className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm" title={draft.workspace}>
                    <FolderCode className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{folderName(draft.workspace)}</span>{' '}
                      <span className="text-muted-foreground">{draft.workspace}</span>
                    </span>
                  </p>
                )}
                {folderError && (
                  <p role="alert" className="mt-2 flex gap-1.5 text-xs text-destructive">
                    <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                    {folderError}
                  </p>
                )}
              </Row>
            )}
            <Row label="Instructions" description="Envoyées au modèle dans chaque conversation du projet : le contexte, ce que tu attends de lui.">
              <Textarea
                value={draft.instructions}
                onChange={(e) => update({ instructions: e.target.value })}
                maxLength={PROJECT_LIMITS.instructions}
                placeholder="Ex. : On travaille sur une appli React + Tauri. Réponds avec du code TypeScript commenté."
                aria-label="Instructions du projet"
                className="max-h-56 min-h-24"
              />
            </Row>
            <Row
              label="Fichiers de référence"
              description={`Fichiers texte (notes, code, CSV…) que le modèle a toujours sous les yeux. Ils sont rangés dans ton Cerveau : les retirer ici ne les supprime pas. ${Math.round((used / PROJECT_LIMITS.filesChars) * 100)} % de la place utilisée.`}
              control={
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      void addFiles([...(e.target.files ?? [])])
                      e.target.value = ''
                    }}
                  />
                  <Button type="button" variant="outline" className="h-9" onClick={() => fileRef.current?.click()}>
                    <Paperclip aria-hidden />
                    Ajouter
                  </Button>
                </>
              }
            >
              {draft.files.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {draft.files.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                      <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatSize(f.size)}</span>
                      <button
                        type="button"
                        onClick={() => update({ files: draft.files.filter((x) => x.id !== f.id) })}
                        aria-label={`Retirer « ${f.name} »`}
                        title="Retirer"
                        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {fileError && (
                <p role="alert" className="mt-2 flex gap-1.5 text-xs text-destructive">
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                  {fileError}
                </p>
              )}
            </Row>
          </Group>

          <Group title="Mémoire">
            <Row
              label="Se souvenir des conversations"
              description="Le modèle résume chaque conversation du projet (une petite requête de plus de temps en temps) et reçoit ces résumés dans les autres conversations."
              control={<Switch checked={draft.memory} onCheckedChange={(memory) => update({ memory })} aria-label="Mémoire du projet" />}
            />
            {project && draft.memory && (
              <Row label="Ce que le projet retient" description={remembered.length ? undefined : 'Rien pour l’instant : les résumés arrivent après les premières réponses.'}>
                {remembered.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {remembered.map((c) => (
                      <li key={c.id} className="flex gap-2 rounded-lg bg-muted/50 p-3 text-sm">
                        <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">{c.title}</p>
                          <p className="text-muted-foreground">{c.summary!.text}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => onForgetSummary(c.id)}
                          aria-label={`Oublier le résumé de « ${c.title} »`}
                          title="Oublier ce résumé"
                          className="h-fit rounded p-0.5 text-muted-foreground hover:text-foreground"
                        >
                          <X className="size-4" aria-hidden />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Row>
            )}
          </Group>
        </form>

        <div className="flex shrink-0 justify-end gap-2 border-t px-5 py-3">
          <Button type="button" variant="ghost" className="h-9" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit" form="project-form" className="h-9 px-4" disabled={!draft.name.trim()}>
            {!project && <FolderPlus aria-hidden />}
            {project ? 'Enregistrer' : isCode ? 'Créer le projet de code' : 'Créer le projet'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Pastilles de couleur + grille d'icônes. Le premier choix de chaque ligne = par défaut (gris, dossier). */
function IconPicker({
  isCode,
  icon,
  color,
  onIcon,
  onColor,
}: {
  isCode: boolean
  icon?: string
  color?: ProjectColor
  onIcon: (icon: string | undefined) => void
  onColor: (color: ProjectColor | undefined) => void
}) {
  const DefaultIcon = defaultProjectIcon({ space: isCode ? 'code' : 'chat' })
  const tint = color ? { color: `var(--project-${color})` } : undefined
  const cell = 'flex size-8 items-center justify-center rounded-lg transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Couleur de l’icône" className="flex flex-wrap gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={!color}
          aria-label="Gris (par défaut)"
          title="Gris (par défaut)"
          onClick={() => onColor(undefined)}
          className={cn(cell, 'size-7 rounded-full bg-muted-foreground/40 ring-offset-2 ring-offset-background', !color && 'ring-2 ring-foreground')}
        >
          {!color && <Check className="size-3.5 text-background" aria-hidden />}
        </button>
        {PROJECT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={PROJECT_COLOR_LABELS[c]}
            title={PROJECT_COLOR_LABELS[c]}
            onClick={() => onColor(c)}
            style={{ backgroundColor: `var(--project-${c})` }}
            className={cn(cell, 'size-7 rounded-full ring-offset-2 ring-offset-background', color === c && 'ring-2 ring-foreground')}
          >
            {color === c && <Check className="size-3.5 text-white" aria-hidden />}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Icône du projet" className="flex flex-wrap gap-1">
        <button
          type="button"
          role="radio"
          aria-checked={!icon}
          aria-label="Dossier (par défaut)"
          title="Dossier (par défaut)"
          onClick={() => onIcon(undefined)}
          className={cn(cell, !icon ? 'bg-accent ring-1 ring-foreground/25' : 'hover:bg-muted')}
        >
          <DefaultIcon className={cn('size-4', !tint && 'text-muted-foreground')} style={tint} aria-hidden />
        </button>
        {Object.entries(PROJECT_ICONS).map(([id, { icon: Icon, label }]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={icon === id}
            aria-label={label}
            title={label}
            onClick={() => onIcon(id)}
            className={cn(cell, icon === id ? 'bg-accent ring-1 ring-foreground/25' : 'hover:bg-muted')}
          >
            <Icon className={cn('size-4', !tint && 'text-muted-foreground')} style={tint} aria-hidden />
          </button>
        ))}
      </div>
      {(icon || color) && (
        <button
          type="button"
          onClick={() => {
            onIcon(undefined)
            onColor(undefined)
          }}
          className="flex w-fit items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <Ban className="size-3.5" aria-hidden />
          Revenir au dossier gris
        </button>
      )}
    </div>
  )
}
