import { Brain, FolderOpen, PanelLeft, Pencil, SlidersHorizontal, SquarePen } from 'lucide-react'
import { AeryLogo } from '@/components/AeryLogo'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Appear } from '@/components/Appear'
import { Composer } from '@/components/Composer'
import { IconButton } from '@/components/IconButton'
import { MessageList } from '@/components/MessageList'
import { ModelPicker } from '@/components/ModelPicker'
import { SettingsDialog, type SettingsTab } from '@/components/SettingsDialog'
import { Sidebar } from '@/components/Sidebar'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useChat, type Conversation } from '@/hooks/useChat'
import { useModels } from '@/hooks/useModels'
import { useVisionModels } from '@/hooks/useVisionModels'
import { useProjects } from '@/hooks/useProjects'
import type { Project } from '@/lib/projects'
import { ProjectDialog } from '@/components/ProjectDialog'
import { Button } from '@/components/ui/button'
import { useNavHistory, type Place } from '@/hooks/useNavHistory'
import { NavArrows, useNavShortcuts } from '@/components/NavArrows'
import { ApiError, getSettings, type Settings } from '@/lib/api'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { hasCustomModelSettings, usePreferences } from '@/lib/preferences'
import { useTheme } from '@/lib/theme'
import { startUpdateChecks } from '@/lib/updates'
import { dragRegion, TRAFFIC_LIGHTS_INSET, TRAFFIC_LIGHTS_INSET_NARROW, useTrafficLights } from '@/lib/titlebar'
import { cn } from '@/lib/utils'

/** Largeur de la barre latérale sur grand écran (w-64). */
const SIDEBAR_WIDTH = 256

/** Ce qu'affiche la zone principale. Modèles, clés, utilisation et analytique sont dans les Paramètres. */
export type View = 'chat'

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true) // grand écran : barre dépliée ou repliée
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false) // mobile : panneau coulissant

  const prefs = usePreferences()
  const motion = useMotion()
  useTheme(prefs.theme)
  const trafficLights = useTrafficLights() // appli macOS : boutons de fenêtre posés sur la page

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  // Incrémenté quand des modèles sont activés / désactivés ou des clés ajoutées (Paramètres).
  const [modelsVersion, setModelsVersion] = useState(0)
  const isVisionModel = useVisionModels(settings?.hasKey ?? false, modelsVersion)
  const projects = useProjects()
  const chat = useChat({ onMissingKey: () => openSettings('connection'), isVisionModel, getProject: projects.getProject })
  // Fenêtre du projet : null = fermée ; { id: null } = création ; { id } = modification.
  const [projectDialog, setProjectDialog] = useState<{ id: string | null } | null>(null)
  const activeProject = chat.activeProjectId ? projects.getProject(chat.activeProjectId) : undefined
  const models = useModels(settings?.hasKey ?? false)
  const { active, activeError, isStreaming, streamingId } = chat
  const activeIsStreaming = active !== null && streamingId === active.id

  // Précédent / Suivant : l'historique observe la page et la conversation ouvertes.
  const { selectConversation, newConversation: resetConversation, conversations } = chat
  const goTo = useCallback(
    (place: Place) => {
      if (place.conversationId) selectConversation(place.conversationId)
      else resetConversation(place.projectId ?? null)
    },
    [selectConversation, resetConversation],
  )
  const placeExists = useCallback(
    (place: Place) =>
      (!place.conversationId || conversations.some((c) => c.id === place.conversationId)) &&
      (!place.projectId || projects.getProject(place.projectId) !== undefined),
    [conversations, projects],
  )
  const nav = useNavHistory(
    { view: 'chat', conversationId: active?.id ?? null, projectId: active ? null : chat.activeProjectId },
    goTo,
    placeExists,
  )
  useNavShortcuts(nav)

  // Au démarrage : on récupère les réglages, et s'il n'y a pas de clé on ouvre les paramètres.
  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s)
        if (!s.hasKey) openSettings('connection')
      })
      .catch((e) => setSettingsError(e instanceof ApiError ? e.message : 'Impossible de lire les réglages.'))
    startUpdateChecks() // appli installée seulement : y a-t-il une nouvelle version dans le repo git ?
  }, [])

  const sidebarProps = {
    conversations: chat.conversations,
    loaded: chat.loaded,
    storageError: chat.storageError,
    activeId: active?.id ?? null,
    streamingId,
    onRename: chat.renameConversation,
    onDelete: chat.deleteConversation,
    onNew: () => {
      chat.newConversation()
      setMobileSidebarOpen(false)
    },
    onSelect: (id: string) => {
      chat.selectConversation(id)
      setMobileSidebarOpen(false)
    },
    onOpenSettings: () => {
      setMobileSidebarOpen(false)
      openSettings(settingsTab)
    },
    onOpenUpdates: () => {
      setMobileSidebarOpen(false)
      openSettings('updates')
    },
    trafficLights,
    nav,
    projects: projects.projects,
    activeProjectId: chat.activeProjectId,
    onOpenProject: (id: string) => {
      chat.newConversation(id)
      setMobileSidebarOpen(false)
    },
    onNewProject: () => {
      setMobileSidebarOpen(false)
      setProjectDialog({ id: null })
    },
    onEditProject: (id: string) => {
      setMobileSidebarOpen(false)
      setProjectDialog({ id })
    },
    onDeleteProject: (id: string) => {
      void projects.deleteProject(id)
      chat.detachProject(id)
    },
    onMove: chat.moveConversation,
  }

  const composer = (
    <Composer
      onSend={chat.send}
      onStop={chat.stop}
      isStreaming={activeIsStreaming}
      busy={isStreaming && !activeIsStreaming}
      focusKey={active?.id ?? 'new'}
      modelReadsImages={isVisionModel(chat.selectedModel)}
    />
  )
  const isEmpty = !active || active.messages.length === 0
  const newConversation = () => chat.newConversation()
  // Largeur de la colonne de messages (réglage « Largeur de la conversation »).
  const widthClass = prefs.chatWidth === 'wide' ? 'max-w-5xl' : 'max-w-3xl'

  // Barre latérale (grand écran) : elle reste dans la page et GSAP anime sa largeur.
  // Au premier affichage, pas d'animation : on la pose directement à la bonne taille.
  const asideRef = useRef<HTMLElement>(null)
  const firstLayoutRef = useRef(true)
  useGSAP(
    () => {
      const width = sidebarOpen ? SIDEBAR_WIDTH : 0
      if (firstLayoutRef.current || !motion) gsap.set(asideRef.current, { width })
      else gsap.to(asideRef.current, { width, duration: 0.35, ease: 'power3.inOut' })
      firstLayoutRef.current = false
    },
    { dependencies: [sidebarOpen] },
  )

  return (
    <TooltipProvider delay={300}>
      <div className="flex h-dvh bg-background text-foreground">
        {/* Grand écran : barre latérale fixe, repliable (inert = ignorée au clavier quand elle est cachée) */}
        <aside ref={asideRef} inert={!sidebarOpen} className="hidden shrink-0 overflow-hidden md:block">
          <div className="h-full w-64 border-r border-sidebar-border">
            <Sidebar {...sidebarProps} onCollapse={() => setSidebarOpen(false)} />
          </div>
        </aside>

        {/* Mobile : panneau qui glisse depuis la gauche */}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="w-72 gap-0 p-0">
            <SheetTitle className="sr-only">Conversations</SheetTitle>
            <Sidebar {...sidebarProps} />
          </SheetContent>
        </Sheet>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* En-tête = barre de titre de la fenêtre. Si la barre latérale est cachée (repliée, ou
              fenêtre étroite), les boutons de fenêtre tombent ici : on leur laisse la place. */}
          <header
            {...dragRegion}
            className={cn(
              'flex h-12 shrink-0 items-center gap-0.5 px-2 select-none',
              trafficLights && (sidebarOpen ? TRAFFIC_LIGHTS_INSET_NARROW : TRAFFIC_LIGHTS_INSET),
            )}
          >
            <div className="md:hidden">
              <IconButton label="Ouvrir la barre latérale" onClick={() => setMobileSidebarOpen(true)}>
                <PanelLeft className="size-5" aria-hidden />
              </IconButton>
            </div>
            {!sidebarOpen && (
              <Appear className="hidden items-center gap-1 md:flex" from={{ autoAlpha: 0, x: -12, delay: 0.15 }}>
                <IconButton label="Afficher la barre latérale" onClick={() => setSidebarOpen(true)}>
                  <PanelLeft className="size-5" aria-hidden />
                </IconButton>
                <NavArrows nav={nav} />
                <IconButton label="Nouvelle conversation" onClick={newConversation}>
                  <SquarePen className="size-5" aria-hidden />
                </IconButton>
              </Appear>
            )}
            <span className="pointer-events-none min-w-0 truncate px-2 text-sm font-medium">
              {activeProject && active && <span className="text-muted-foreground">{activeProject.name} / </span>}
              {active?.title ?? activeProject?.name ?? 'Nouvelle conversation'}
            </span>
            <div className="ml-auto flex items-center gap-1">
              <IconButton label="Réglages du modèle" onClick={() => openSettings('model')} className="relative">
                <SlidersHorizontal className="size-4" aria-hidden />
                {/* Petit point : des réglages personnalisés sont actifs (prompt système, température…) */}
                {hasCustomModelSettings(prefs) && (
                  <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-primary" aria-hidden />
                )}
              </IconButton>
              <ModelPicker
                value={chat.selectedModel}
                onChange={chat.setModel}
                models={models.models}
                loading={models.loading}
                error={models.error}
                onOpen={models.refreshIfStale}
                onRefresh={() => void models.refresh()}
              />
            </div>
            <div className="ml-auto md:ml-0 md:hidden">
              <IconButton label="Nouvelle conversation" onClick={newConversation}>
                <SquarePen className="size-5" aria-hidden />
              </IconButton>
            </div>
          </header>

          {settingsError && (
            <p role="alert" className="mx-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              {settingsError}
            </p>
          )}

          {isEmpty && activeProject ? (
            // Accueil d'un projet : son nom, ses conversations, et une zone de saisie pour en commencer une.
            <ProjectHome
              key={activeProject.id}
              project={activeProject}
              conversations={chat.conversations.filter((c) => c.projectId === activeProject.id)}
              composer={composer}
              widthClass={widthClass}
              onEdit={() => setProjectDialog({ id: activeProject.id })}
              onSelect={chat.selectConversation}
            />
          ) : isEmpty ? (
            // Conversation vide : titre et zone de saisie au centre, comme ChatGPT.
            // key : l'animation d'accueil se rejoue à chaque nouvelle conversation.
            <Appear
              key={active?.id ?? 'new'}
              stagger={0.1}
              from={{ autoAlpha: 0, y: 24, duration: 0.6 }}
              className="flex flex-1 flex-col items-center justify-center gap-6 px-4 pb-[10vh]"
            >
              <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
                <AeryLogo className="size-6" aria-hidden />
              </span>
              <h2 className="text-center text-2xl font-semibold sm:text-3xl">Comment je peux t’aider ?</h2>
              <div className={cn('w-full', widthClass)}>{composer}</div>
            </Appear>
          ) : (
            <>
              <MessageList
                key={active.id} // nouvelle conversation = nouveau composant (le défilement repart en bas)
                messages={active.messages}
                isStreaming={activeIsStreaming}
                error={activeError}
                canRetry={!isStreaming && activeError !== null}
                onRetry={chat.retry}
                widthClass={widthClass}
              />
              <div className={cn('mx-auto w-full px-4 pb-4', widthClass)}>
                {composer}
                <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
                  Entrée pour envoyer · Maj + Entrée pour aller à la ligne
                </p>
              </div>
            </>
          )}
        </div>
      </div>

      {projectDialog && (
        <ProjectDialog
          project={projectDialog.id ? (projects.getProject(projectDialog.id) ?? null) : null}
          conversations={chat.conversations}
          onClose={() => setProjectDialog(null)}
          onForgetSummary={chat.forgetSummary}
          onSave={(draft) => {
            if (projectDialog.id) projects.updateProject(projectDialog.id, draft)
            else chat.newConversation(projects.createProject(draft).id) // on ouvre le nouveau projet
            setProjectDialog(null)
          }}
        />
      )}

      <SettingsDialog
        open={settingsOpen}
        tab={settingsTab}
        onTabChange={setSettingsTab}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSaved={(s) => {
          setSettings(s)
          // Nouvelle clé ou nouveau port : la liste des modèles a pu changer.
          if (s.hasKey) void models.refresh()
        }}
        onModelsChanged={() => {
          void models.refresh()
          setModelsVersion((v) => v + 1)
        }}
      />
    </TooltipProvider>
  )
}

/** Accueil d'un projet : nom, instructions, conversations du projet, et la zone de saisie. */
function ProjectHome({
  project,
  conversations,
  composer,
  widthClass,
  onEdit,
  onSelect,
}: {
  project: Project
  conversations: Conversation[]
  composer: ReactNode
  widthClass: string
  onEdit: () => void
  onSelect: (id: string) => void
}) {
  const details = [
    project.instructions.trim() && 'instructions',
    project.files.length > 0 && `${project.files.length} fichier${project.files.length > 1 ? 's' : ''}`,
    project.memory && 'mémoire activée',
  ].filter(Boolean)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Appear stagger={0.08} from={{ autoAlpha: 0, y: 20, duration: 0.5 }} className={cn('mx-auto flex w-full flex-col gap-6 px-4 pt-[12vh] pb-8', widthClass)}>
        <div className="flex items-center gap-3">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-muted">
            <FolderOpen className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-semibold">{project.name}</h2>
            <p className="text-sm text-muted-foreground">{details.length ? details.join(' · ') : 'Ajoute des instructions pour donner du contexte au modèle.'}</p>
          </div>
          <Button variant="outline" className="h-9" onClick={onEdit}>
            <Pencil aria-hidden />
            Modifier
          </Button>
        </div>
        {composer}
        {conversations.length > 0 && (
          <section aria-label="Conversations du projet">
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">Conversations du projet</h3>
            <ul className="flex flex-col divide-y rounded-2xl border">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => onSelect(c.id)} className="flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/50">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <span className="truncate">{c.title}</span>
                      {c.summary && <Brain className="size-3.5 shrink-0 text-muted-foreground" aria-label="Retenue dans la mémoire du projet" />}
                    </span>
                    {c.summary && <span className="line-clamp-2 text-sm text-muted-foreground">{c.summary.text}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </Appear>
    </div>
  )
}
