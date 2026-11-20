import {
  Brain,
  ChevronRight,
  CircleArrowUp,
  CircleAlert,
  CodeXml,
  FolderInput,
  FolderMinus,
  FolderPlus,
  LoaderCircle,
  MessageSquare,
  MoreHorizontal,
  Plus,
  PanelLeftClose,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import { AeryLogo } from '@/components/AeryLogo'
import { Collapse } from '@/components/Collapse'
import { ProjectIcon } from '@/components/ProjectIcon'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
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
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { IconButton } from '@/components/IconButton'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { Conversation } from '@/hooks/useChat'
import { projectSpace, type AppSpace, type Project } from '@/lib/projects'
import { BRAIN_KIND_ICONS } from '@/components/brain/kinds'
import { itemTitle, type BrainItem } from '@/lib/brain'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { useUpdates } from '@/lib/updates'
import { Appear } from '@/components/Appear'
import { dragRegion, TRAFFIC_LIGHTS_INSET } from '@/lib/titlebar'
import { NavArrows, type NavControls } from '@/components/NavArrows'

interface Props {
  conversations: Conversation[]
  loaded: boolean
  storageError: string | null
  activeId: string | null
  streamingId: string | null
  onNew: () => void
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  /** Ouvre les Paramètres sur la page « Mises à jour ». */
  onOpenUpdates: () => void
  /** Bouton « replier » : seulement sur grand écran (sur mobile, le panneau se ferme tout seul). */
  onCollapse?: () => void
  /** Appli macOS : les boutons de fenêtre sont posés sur le haut de la barre, on leur laisse la place. */
  trafficLights?: boolean
  /** Flèches Précédent / Suivant. */
  nav?: NavControls
  projects: Project[]
  /** Projet ouvert (celui de la conversation, ou l'accueil d'un projet). */
  activeProjectId: string | null
  onOpenProject: (id: string) => void
  onNewProject: () => void
  onEditProject: (id: string) => void
  onDeleteProject: (id: string) => void
  onMove: (conversationId: string, projectId: string | null) => void
  /** Espace affiché : Chat (conversations normales), Code (projets liés à un dossier, mode Agent) ou Cerveau. */
  space: AppSpace
  onSpaceChange: (space: AppSpace) => void
  /** Espace Code : ajouter un projet (un dossier). */
  onAddCodeProject: () => void
  /** Espace Cerveau : les éléments récents, et de quoi en ouvrir / créer. */
  brainItems: BrainItem[]
  /** Note ouverte en pleine page (surlignée dans « Récents »). */
  activeNoteId: string | null
  onNewNote: () => void
  onOpenNote: (id: string) => void
}

/** Éléments récents du cerveau affichés dans la barre latérale. */
const RECENT_NOTES = 40

// --- Regroupement par date, comme ChatGPT -------------------------------------------

const DAY = 24 * 60 * 60 * 1000

function groupLabel(timestamp: number, todayStart: number): string {
  if (timestamp >= todayStart) return 'Aujourd’hui'
  if (timestamp >= todayStart - DAY) return 'Hier'
  if (timestamp >= todayStart - 7 * DAY) return '7 derniers jours'
  if (timestamp >= todayStart - 30 * DAY) return '30 derniers jours'
  return 'Plus ancien'
}

/** Les conversations arrivent déjà triées (plus récente d'abord) : on les découpe en groupes. */
function groupByDate(conversations: Conversation[]): { label: string; items: Conversation[] }[] {
  const todayStart = new Date().setHours(0, 0, 0, 0)
  const groups: { label: string; items: Conversation[] }[] = []
  for (const c of conversations) {
    const label = groupLabel(c.updatedAt, todayStart)
    const last = groups.at(-1)
    if (last?.label === label) last.items.push(c)
    else groups.push({ label, items: [c] })
  }
  return groups
}

// --- La barre latérale ---------------------------------------------------------------

export function Sidebar(props: Props) {
  const { conversations, loaded, storageError, onNew, onOpenSettings, onOpenUpdates, onCollapse, onDelete, trafficLights, nav, projects, activeProjectId, space } = props
  const isCode = space === 'code'
  const isBrain = space === 'brain'
  // Projets de l'espace affiché (la liste complète reste dans props.projects, pour « Déplacer vers »).
  const spaceProjects = projects.filter((p) => projectSpace(p) === space)
  const addProject = isCode ? props.onAddCodeProject : props.onNewProject
  const [pendingProjectDelete, setPendingProjectDelete] = useState<Project | null>(null)
  // Projets dépliés. Celui qu'on ouvre se déplie tout seul (synchronisé pendant le rendu, pas dans un effet).
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(activeProjectId ? [activeProjectId] : []))
  const [lastActiveProject, setLastActiveProject] = useState(activeProjectId)
  if (activeProjectId !== lastActiveProject) {
    setLastActiveProject(activeProjectId)
    if (activeProjectId && !expanded.has(activeProjectId)) setExpanded(new Set([...expanded, activeProjectId]))
  }
  const toggleProject = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  // Conversations hors projet (ou dont le projet n'existe plus) : la liste par date habituelle.
  const projectIds = new Set(projects.map((p) => p.id))
  const loose = conversations.filter((c) => !c.projectId || !projectIds.has(c.projectId))
  const updates = useUpdates()
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  const motion = useMotion()
  const navRef = useRef<HTMLElement>(null)

  // Une conversation créée APRÈS l'affichage de la barre est nouvelle : elle s'animera en apparaissant.
  const [mountedAt] = useState(() => Date.now())

  // Historique chargé : toute la liste arrive en cascade (une seule fois, quand loaded passe à true).
  useGSAP(
    () => {
      if (loaded && motion) gsap.from('[data-conv-item]', { autoAlpha: 0, x: -12, stagger: 0.03, clearProps: 'all' })
    },
    { scope: navRef, dependencies: [loaded] },
  )

  const collapseButton = onCollapse && (
    <IconButton label="Masquer la barre latérale" onClick={onCollapse}>
      <PanelLeftClose className="size-5" aria-hidden />
    </IconButton>
  )

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      {/* En-tête = aussi la barre de titre de la fenêtre (on peut l'attraper pour la déplacer).
          Appli macOS, comme Claude : boutons de fenêtre, puis replier + flèches, sans logo
          (il est déjà sur l'écran d'accueil). Version web : logo à gauche, boutons à droite. */}
      <div
        {...dragRegion}
        className={cn('flex h-12 shrink-0 items-center gap-0.5 px-2 select-none', trafficLights && TRAFFIC_LIGHTS_INSET)}
      >
        {!trafficLights && (
          <span className="pointer-events-none mr-auto flex items-center gap-2 px-1 font-semibold">
            <AeryLogo className="size-5" aria-hidden />
            Aery
          </span>
        )}
        {trafficLights && collapseButton}
        {nav && <NavArrows nav={nav} />}
        {!trafficLights && collapseButton}
      </div>

      <div className="flex flex-col gap-2 px-2">
        <SpaceSwitcher space={space} onChange={props.onSpaceChange} />
        <Button variant="ghost" className="h-9 w-full justify-start gap-2 px-2" onClick={isBrain ? props.onNewNote : onNew}>
          <SquarePen className="size-4" aria-hidden />
          {isBrain ? 'Nouvelle note' : 'Nouvelle conversation'}
        </Button>
      </div>

      {isBrain ? (
        <nav aria-label="Éléments récents du cerveau" className="flex-1 overflow-y-auto px-2 py-3">
          <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Récents</h3>
          {props.brainItems.length === 0 ? (
            <p className="px-2 text-sm text-muted-foreground">Rien pour l’instant. Garde une réponse du chat ou écris une note.</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {[...props.brainItems]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, RECENT_NOTES)
                .map((item) => {
                  const Icon = BRAIN_KIND_ICONS[item.kind]
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => props.onOpenNote(item.id)}
                        aria-current={item.id === props.activeNoteId ? 'page' : undefined}
                        className={cn(
                          'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50',
                          item.id === props.activeNoteId && 'bg-sidebar-accent',
                        )}
                      >
                        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate">{itemTitle(item)}</span>
                      </button>
                    </li>
                  )
                })}
            </ul>
          )}
        </nav>
      ) : (
      <nav ref={navRef} aria-label="Conversations" className="flex-1 overflow-y-auto px-2 py-3">
        {storageError && (
          <p role="alert" className="mb-3 flex gap-2 rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {storageError}
          </p>
        )}
        {/* Projets : des dossiers de conversations qui partagent instructions, fichiers et mémoire.
            Espace Code : chaque projet est lié à un dossier que l'agent peut lire. */}
        <section className="mb-4" aria-label={isCode ? 'Projets de code' : 'Projets'}>
          <div className="flex items-center justify-between pr-0.5 pl-2">
            <h3 className="text-xs font-medium text-muted-foreground">{isCode ? 'Projets de code' : 'Projets'}</h3>
            <IconButton label={isCode ? 'Ajouter un dossier' : 'Nouveau projet'} size="icon-sm" onClick={addProject} className="text-muted-foreground">
              <Plus className="size-3.5" aria-hidden />
            </IconButton>
          </div>
          {spaceProjects.length === 0 ? (
            <Button variant="ghost" className="h-8 w-full justify-start gap-2 px-2 text-sm font-normal text-muted-foreground" onClick={addProject}>
              <FolderPlus className="size-4" aria-hidden />
              {isCode ? 'Ajouter un dossier' : 'Nouveau projet'}
            </Button>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {spaceProjects.map((p) => {
                const items = conversations.filter((c) => c.projectId === p.id)
                const open = expanded.has(p.id)
                return (
                  <li key={p.id}>
                    <ProjectItem
                      project={p}
                      open={open}
                      count={items.length}
                      active={activeProjectId === p.id && (props.activeId === null || !items.some((c) => c.id === props.activeId))}
                      onToggle={() => toggleProject(p.id)}
                      onOpen={() => {
                        // Clic sur le dossier : on l'ouvre et on le déplie. Déjà affiché et déplié : on le replie.
                        const showing = activeProjectId === p.id && props.activeId === null
                        if (showing && open) toggleProject(p.id)
                        else if (!open) toggleProject(p.id)
                        props.onOpenProject(p.id)
                      }}
                      onEdit={() => props.onEditProject(p.id)}
                      onAskDelete={() => setPendingProjectDelete(p)}
                    />
                    <Collapse open={open && items.length > 0} className="pt-0.5">
                      <ul className="ml-4 flex flex-col gap-0.5 border-l border-sidebar-border pl-1.5">
                        {items.map((c) => (
                          <ConversationItem
                            key={c.id}
                            conversation={c}
                            {...props}
                            onAskDelete={setPendingDelete}
                            animateIn={c.createdAt > mountedAt}
                          />
                        ))}
                      </ul>
                    </Collapse>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {isCode ? null : !loaded ? (
          <LoaderCircle className="mx-2 size-4 animate-spin text-muted-foreground" aria-label="Chargement de l’historique" />
        ) : loose.length === 0 ? (
          conversations.length === 0 && <p className="px-2 text-sm text-muted-foreground">Aucune conversation pour l’instant.</p>
        ) : (
          groupByDate(loose).map((group) => (
            <section key={group.label} className="mb-4">
              <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</h3>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((c) => (
                  <ConversationItem
                    key={c.id}
                    conversation={c}
                    {...props}
                    onAskDelete={setPendingDelete}
                    animateIn={c.createdAt > mountedAt}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </nav>
      )}

      {/* Une nouvelle version de l'appli est prête (vérifiée au lancement puis toutes les 6 h). */}
      {updates.status?.available && (
        <Appear from={{ autoAlpha: 0, y: 8 }} className="border-t border-sidebar-border p-2">
          <Button variant="ghost" className="h-9 w-full justify-start gap-2 px-2 text-primary hover:text-primary" onClick={onOpenUpdates}>
            {updates.running ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <CircleArrowUp className="size-4" aria-hidden />
            )}
            {updates.running ? 'Mise à jour en cours…' : 'Mise à jour disponible'}
          </Button>
        </Appear>
      )}

      <div className="flex items-center gap-1 border-t border-sidebar-border p-2">
        <Button variant="ghost" className="h-9 flex-1 justify-start gap-2 px-2" onClick={onOpenSettings}>
          <Settings className="size-4" aria-hidden />
          Paramètres
        </Button>
        <ThemeToggle />
      </div>

      <AlertDialog open={pendingProjectDelete !== null} onOpenChange={(open) => !open && setPendingProjectDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le projet ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {pendingProjectDelete?.name} » et ses instructions seront supprimés
              {projectSpace(pendingProjectDelete ?? undefined) === 'code' && ' (le dossier lui-même n’est pas touché)'}. Ses conversations
              sont gardées (elles reviennent dans la liste principale du Chat), et ses fichiers restent dans le Cerveau.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingProjectDelete) props.onDeleteProject(pendingProjectDelete.id)
                setPendingProjectDelete(null)
              }}
            >
              Supprimer le projet
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmation avant suppression (c'est définitif) */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer la conversation ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {pendingDelete?.title} » sera supprimée définitivement. Cette action est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDelete) onDelete(pendingDelete.id)
                setPendingDelete(null)
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

// --- Une ligne de la liste -------------------------------------------------------------

function ConversationItem({
  conversation: c,
  activeId,
  streamingId,
  onSelect,
  onRename,
  onAskDelete,
  animateIn,
  projects,
  onMove,
}: Props & { conversation: Conversation; onAskDelete: (c: Conversation) => void; animateIn: boolean }) {
  const [renaming, setRenaming] = useState(false)
  const itemRef = useRef<HTMLLIElement>(null)
  const motion = useMotion()

  // Nouvelle conversation : la ligne se déplie en hauteur puis apparaît.
  useGSAP(() => {
    if (!animateIn || !motion || !itemRef.current) return
    gsap.from(itemRef.current, { height: 0, autoAlpha: 0, x: -16, duration: 0.45, clearProps: 'all' })
  })
  const [draft, setDraft] = useState(c.title)
  const inputRef = useRef<HTMLInputElement>(null)
  const isActive = c.id === activeId

  useEffect(() => {
    if (renaming) inputRef.current?.select() // sélectionne le titre pour le remplacer d'un coup
  }, [renaming])

  function finishRename(save: boolean) {
    if (save && draft.trim() && draft.trim() !== c.title) onRename(c.id, draft)
    setRenaming(false)
  }

  if (renaming) {
    return (
      <li>
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => finishRename(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finishRename(true)
            if (e.key === 'Escape') finishRename(false)
          }}
          maxLength={100}
          aria-label="Nouveau titre"
          className="h-8"
        />
      </li>
    )
  }

  return (
    <li
      ref={itemRef}
      data-conv-item
      className={cn(
        'group/item flex items-center rounded-lg transition-colors hover:bg-sidebar-accent',
        isActive && 'bg-sidebar-accent',
      )}
    >
      <button
        onClick={() => onSelect(c.id)}
        aria-current={isActive ? 'page' : undefined}
        title={c.title}
        className={cn('min-w-0 flex-1 truncate py-1.5 pl-2 text-left text-sm', isActive && 'font-medium')}
      >
        {c.title}
      </button>

      {c.id === streamingId && (
        <LoaderCircle className="mx-1 size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Réponse en cours" />
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Options de « ${c.title} »`}
              className={cn(
                'mr-0.5 shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground',
                // Visible au survol, sur la conversation active, menu ouvert, ou sur écran tactile.
                'opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100',
                isActive && 'opacity-100',
              )}
            />
          }
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        {/* finalFocus : en mode renommage, on ne rend pas le focus au bouton (sinon le champ le perdrait). */}
        <DropdownMenuContent align="start" className="w-44" finalFocus={!renaming}>
          <DropdownMenuItem
            onClick={() => {
              setDraft(c.title)
              setRenaming(true)
            }}
          >
            <Pencil aria-hidden />
            Renommer
          </DropdownMenuItem>
          <MoveMenu conversation={c} projects={projects} onMove={onMove} />
          <DropdownMenuItem variant="destructive" onClick={() => onAskDelete(c)}>
            <Trash2 aria-hidden />
            Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

// --- Un projet dans la liste -----------------------------------------------------------

function ProjectItem({
  project,
  open,
  count,
  active,
  onToggle,
  onOpen,
  onEdit,
  onAskDelete,
}: {
  project: Project
  open: boolean
  count: number
  active: boolean
  onToggle: () => void
  onOpen: () => void
  onEdit: () => void
  onAskDelete: () => void
}) {
  const code = projectSpace(project) === 'code'
  // Petit « pop » de l'icône quand on déplie / replie (pas au premier affichage).
  const motion = useMotion()
  const iconRef = useRef<HTMLSpanElement>(null)
  const prevOpen = useRef(open)
  useGSAP(
    () => {
      if (prevOpen.current === open) return
      prevOpen.current = open
      if (!motion || !iconRef.current) return
      gsap.fromTo(iconRef.current, { scale: 0.8, rotate: open ? -8 : 8 }, { scale: 1, rotate: 0, duration: 0.35, ease: 'back.out(3)', clearProps: 'transform' })
    },
    { dependencies: [open] },
  )
  return (
    <div className={cn('group/item flex items-center rounded-lg transition-colors hover:bg-sidebar-accent', active && 'bg-sidebar-accent')}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? 'Replier' : 'Déplier'} « ${project.name} » (${count} conversation${count > 1 ? 's' : ''})`}
        title={open ? 'Replier' : 'Déplier'}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 transition-transform duration-200', open && 'rotate-90')} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onOpen}
        aria-current={active ? 'page' : undefined}
        title={code && project.workspace ? `${project.name}\n${project.workspace}` : project.name}
        className={cn('flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm', active && 'font-medium')}
      >
        <span ref={iconRef} className="flex shrink-0">
          <ProjectIcon project={project} open={open} className="size-4" />
        </span>
        <span className="truncate">{project.name}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Options du projet « ${project.name} »`}
              className="mr-0.5 shrink-0 text-muted-foreground opacity-0 group-hover/item:opacity-100 hover:bg-transparent hover:text-foreground focus-visible:opacity-100 data-[popup-open]:opacity-100 [@media(hover:none)]:opacity-100"
            />
          }
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuItem onClick={onOpen}>
            <SquarePen aria-hidden />
            Nouvelle conversation
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onEdit}>
            <Pencil aria-hidden />
            Modifier le projet
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onAskDelete}>
            <Trash2 aria-hidden />
            Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

// --- Sélecteur d'espace -----------------------------------------------------------------

/** Chat | Code | Cerveau, comme les onglets de l'appli Claude. */
function SpaceSwitcher({ space, onChange }: { space: AppSpace; onChange: (space: AppSpace) => void }) {
  const options = [
    { value: 'chat' as const, label: 'Chat', Icon: MessageSquare },
    { value: 'code' as const, label: 'Code', Icon: CodeXml },
    { value: 'brain' as const, label: 'Cerveau', Icon: Brain },
  ]
  return (
    <div role="group" aria-label="Espace" className="grid grid-cols-3 gap-1 rounded-lg bg-sidebar-accent/60 p-0.5">
      {options.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={space === value}
          onClick={() => onChange(value)}
          className={cn(
            'flex h-7 items-center justify-center gap-1.5 rounded-md text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            space === value ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  )
}

// --- « Déplacer vers » : projets du Chat et projets de code -------------------------------

function MoveMenu({
  conversation: c,
  projects,
  onMove,
}: {
  conversation: Conversation
  projects: Project[]
  onMove: (conversationId: string, projectId: string | null) => void
}) {
  const others = projects.filter((p) => p.id !== c.projectId)
  const chat = others.filter((p) => projectSpace(p) === 'chat')
  const code = others.filter((p) => projectSpace(p) === 'code')
  const canLeave = Boolean(c.projectId) // « Hors projet » = liste principale du Chat
  if (!chat.length && !code.length && !canLeave) return null

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <FolderInput aria-hidden />
        Déplacer vers
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-52">
        {(chat.length > 0 || canLeave) && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Chat</DropdownMenuLabel>
            {chat.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onMove(c.id, p.id)}>
                <ProjectIcon project={p} />
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
            {canLeave && (
              <DropdownMenuItem onClick={() => onMove(c.id, null)}>
                <FolderMinus aria-hidden />
                Hors projet
              </DropdownMenuItem>
            )}
          </DropdownMenuGroup>
        )}
        {(chat.length > 0 || canLeave) && code.length > 0 && <DropdownMenuSeparator />}
        {code.length > 0 && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Code</DropdownMenuLabel>
            {code.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => onMove(c.id, p.id)}>
                <ProjectIcon project={p} />
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
