import {
  Boxes,
  ChartColumn,
  CircleArrowUp,
  CircleAlert,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Settings,
  SquarePen,
  Trash2,
} from 'lucide-react'
import type { View } from '@/App'
import { AeryLogo } from '@/components/AeryLogo'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { IconButton } from '@/components/IconButton'
import { ThemeToggle } from '@/components/ThemeToggle'
import type { Conversation } from '@/hooks/useChat'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { useUpdates } from '@/lib/updates'
import { Appear } from '@/components/Appear'

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
  /** Page affichée (chat, Modèles, Analytique) et navigation entre elles. */
  view: View
  onNavigate: (view: View) => void
  /** Bouton « replier » : seulement sur grand écran (sur mobile, le panneau se ferme tout seul). */
  onCollapse?: () => void
}

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
  const { conversations, loaded, storageError, onNew, onOpenSettings, onOpenUpdates, onCollapse, onDelete, view, onNavigate } = props
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

  return (
    <div className="flex h-full flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between px-3">
        <span className="flex items-center gap-2 font-semibold">
          <AeryLogo className="size-5" aria-hidden />
          Aery
        </span>
        {onCollapse && (
          <IconButton label="Masquer la barre latérale" onClick={onCollapse}>
            <PanelLeftClose className="size-5" aria-hidden />
          </IconButton>
        )}
      </div>

      <div className="px-2">
        <Button variant="ghost" className="h-9 w-full justify-start gap-2 px-2" onClick={onNew}>
          <SquarePen className="size-4" aria-hidden />
          Nouvelle conversation
        </Button>
        {/* Pages de statistiques FreeLLMAPI (lecture seule) */}
        {(
          [
            { id: 'models', label: 'Modèles', icon: Boxes },
            { id: 'analytics', label: 'Analytique', icon: ChartColumn },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant="ghost"
            aria-current={view === id ? 'page' : undefined}
            className={cn('h-9 w-full justify-start gap-2 px-2', view === id && 'bg-sidebar-accent font-medium')}
            onClick={() => onNavigate(id)}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Button>
        ))}
      </div>

      <nav ref={navRef} aria-label="Conversations" className="flex-1 overflow-y-auto px-2 py-3">
        {storageError && (
          <p role="alert" className="mb-3 flex gap-2 rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {storageError}
          </p>
        )}
        {!loaded ? (
          <LoaderCircle className="mx-2 size-4 animate-spin text-muted-foreground" aria-label="Chargement de l’historique" />
        ) : conversations.length === 0 ? (
          <p className="px-2 text-sm text-muted-foreground">Aucune conversation pour l’instant.</p>
        ) : (
          groupByDate(conversations).map((group) => (
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
  view,
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
  const isActive = c.id === activeId && view === 'chat' // sur une page de stats, aucune conversation n'est « ouverte »

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
        <DropdownMenuContent align="start" className="w-40" finalFocus={!renaming}>
          <DropdownMenuItem
            onClick={() => {
              setDraft(c.title)
              setRenaming(true)
            }}
          >
            <Pencil aria-hidden />
            Renommer
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => onAskDelete(c)}>
            <Trash2 aria-hidden />
            Supprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
