import { Brain, CodeXml, FolderPlus, PanelLeft, Pencil, SlidersHorizontal, SquarePen } from 'lucide-react'
import { AeryLogo } from '@/components/AeryLogo'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Appear } from '@/components/Appear'
import { Composer } from '@/components/Composer'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { IconButton } from '@/components/IconButton'
import { MessageList } from '@/components/MessageList'
import { Onboarding } from '@/components/Onboarding'
import { ModelPicker } from '@/components/ModelPicker'
import { SettingsDialog, type SettingsTab } from '@/components/SettingsDialog'
import { Sidebar } from '@/components/Sidebar'
import { UsageCard } from '@/components/UsageCard'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useChat, type Conversation } from '@/hooks/useChat'
import { useModels } from '@/hooks/useModels'
import { useModelCapabilities } from '@/hooks/useModelCapabilities'
import { useProjects } from '@/hooks/useProjects'
import { useBrain } from '@/hooks/useBrain'
import { BrainHome } from '@/components/brain/BrainHome'
import { BrainNotePage } from '@/components/brain/BrainNotePage'
import { useBrainTidy } from '@/hooks/useBrainTidy'
import { itemTitle } from '@/lib/brain'
import { useSlashCommands } from '@/hooks/useSlashCommands'
import { conversationSpace, projectSpace, type AppSpace, type Project, type Space } from '@/lib/projects'
import type { Attachment } from '@/lib/attachments'
import { ProjectSources } from '@/components/ProjectSources'
import { attachmentKey } from '@/lib/projectSources'
import { folderName, pickWorkspace, releaseWorkspace } from '@/lib/agent/tools'
import { IS_TAURI } from '@/lib/transport'
import { ProjectDialog } from '@/components/ProjectDialog'
import { ProjectBadge, ProjectIcon } from '@/components/ProjectIcon'
import { Button } from '@/components/ui/button'
import { useNavHistory, type Place } from '@/hooks/useNavHistory'
import { NavArrows, useNavShortcuts } from '@/components/NavArrows'
import { ApiError, getSettings, type Settings } from '@/lib/api'
import { readSaveHint, STARTER_MESSAGE, writeSaveHint } from '@/lib/onboarding'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { hasCustomModelSettings, usePreferences } from '@/lib/preferences'
import { useTheme } from '@/lib/theme'
import { startUpdateChecks } from '@/lib/updates'
import { dragRegion, TRAFFIC_LIGHTS_INSET, TRAFFIC_LIGHTS_INSET_NARROW, useTrafficLights } from '@/lib/titlebar'
import { cn } from '@/lib/utils'

/** Largeur de la barre latérale sur grand écran (w-72 = 288 px : les titres ont de la place, et les boutons de fenêtre en prennent 92). */
const SIDEBAR_WIDTH = 288

/** Ce qu'affiche la zone principale. Modèles, clés, utilisation et analytique sont dans les Paramètres. */
export type View = 'chat'

// Espace affiché au lancement : le dernier utilisé (simple préférence, rien de secret).
const SPACE_KEY = 'freellm-chat:space'

function readSpace(): AppSpace {
  try {
    const stored = localStorage.getItem(SPACE_KEY)
    return stored === 'code' || stored === 'brain' ? stored : 'chat'
  } catch {
    return 'chat'
  }
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true) // grand écran : barre dépliée ou repliée
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false) // mobile : panneau coulissant
  // Écran « Connecter FreeLLMAPI » (appli seulement) : null = fermé, 'first' = premier lancement, 'repair' = depuis une erreur.
  const [onboarding, setOnboarding] = useState<'first' | 'repair' | null>(null)
  // Premier message proposé après la connexion (modifiable, envoyé par la personne).
  const [starter, setStarter] = useState('')
  // Mettre en avant « Garder dans le cerveau » sous la première réponse.
  const [saveHint, setSaveHint] = useState(readSaveHint)

  const prefs = usePreferences()
  const motion = useMotion()
  useTheme(prefs.theme)
  const trafficLights = useTrafficLights() // appli macOS : boutons de fenêtre posés sur la page

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  /** Clé refusée, absente ou FreeLLMAPI injoignable : écran de connexion (appli) ou Paramètres › Connexion (web). */
  function repairConnection() {
    if (IS_TAURI) setOnboarding((o) => o ?? 'repair')
    else openSettings('connection')
  }

  function dismissSaveHint() {
    setSaveHint(false)
    writeSaveHint(false)
  }

  // Demandes d'ouverture venues d'ailleurs (ex. « Ouvrir Paramètres › Dictée » sous le champ de saisie).
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail === 'dictation') {
        setSettingsTab('dictation')
        setSettingsOpen(true)
      }
    }
    window.addEventListener('aery:open-settings', onOpen)
    return () => window.removeEventListener('aery:open-settings', onOpen)
  }, [])

  // Incrémenté quand des modèles sont activés / désactivés ou des clés ajoutées (Paramètres).
  const [modelsVersion, setModelsVersion] = useState(0)
  const { isVisionModel, isToolModel } = useModelCapabilities(settings?.hasKey ?? false, modelsVersion)
  const projects = useProjects()
  const brain = useBrain()
  const chat = useChat({
    brainItems: brain.items,
    onMissingKey: repairConnection,
    isVisionModel,
    isToolModel,
    getProject: projects.getProject,
  })
  // Fenêtre du projet : null = fermée ; { id: null, space } = création ; { id } = modification.
  const [projectDialog, setProjectDialog] = useState<{ id: string | null; space?: Space } | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const activeProject = chat.activeProjectId ? projects.getProject(chat.activeProjectId) : undefined

  // Espace Chat / Code. Une conversation ou un projet ouvert impose son espace : on se synchronise
  // pendant le rendu (pas dans un effet), comme pour les projets dépliés de la barre latérale.
  const [space, setSpace] = useState<AppSpace>(readSpace)
  // Note du cerveau ouverte en pleine page (espace Cerveau), null = accueil du Cerveau.
  const [noteId, setNoteId] = useState<string | null>(null)
  const openNote = brain.items.find((i) => i.id === noteId)
  const imposedSpace = chat.active
    ? conversationSpace(chat.active, projects.getProject)
    : activeProject
      ? projectSpace(activeProject)
      : null
  if (imposedSpace && imposedSpace !== space) setSpace(imposedSpace)
  useEffect(() => {
    try {
      localStorage.setItem(SPACE_KEY, space)
    } catch {
      // pas grave : on repartira sur le Chat
    }
  }, [space])
  const codeProjects = projects.projects.filter((p) => projectSpace(p) === 'code')
  const models = useModels(settings?.hasKey ?? false)
  const { active, activeError, isStreaming, streamingId } = chat
  // Une conversation ouverte remplace la note (synchronisé pendant le rendu).
  if (active && noteId) setNoteId(null)
  // Rangement hebdomadaire du cerveau (et export Obsidian).
  const tidy = useBrainTidy(brain, projects.projects, settings?.hasKey ?? false)

  // Une note quittée vide (« Nouvelle note » sans rien écrire) est supprimée. Comparaison avec la
  // note précédente dans le corps de l'effet (pas dans son nettoyage) : sûr avec le StrictMode.
  const previousNote = useRef<string | null>(null)
  const { snapshot: brainSnapshot, remove: removeBrainItem } = brain
  useEffect(() => {
    const prev = previousNote.current
    previousNote.current = noteId
    if (!prev || prev === noteId) return
    const left = brainSnapshot().find((i) => i.id === prev)
    if (left && left.kind === 'note' && !left.title.trim() && !left.content.trim() && left.tags.length === 0) removeBrainItem(prev)
  }, [noteId, brainSnapshot, removeBrainItem])
  const activeIsStreaming = active !== null && streamingId === active.id

  // Précédent / Suivant : l'historique observe la page et la conversation ouvertes.
  const { selectConversation, newConversation: resetConversation, conversations } = chat
  const goTo = useCallback(
    (place: Place) => {
      setSpace(place.space)
      setNoteId(place.noteId ?? null)
      if (place.conversationId) selectConversation(place.conversationId)
      else resetConversation(place.projectId ?? null)
    },
    [selectConversation, resetConversation, setSpace],
  )
  const placeExists = useCallback(
    (place: Place) =>
      (!place.conversationId || conversations.some((c) => c.id === place.conversationId)) &&
      (!place.projectId || projects.getProject(place.projectId) !== undefined) &&
      (!place.noteId || brain.items.some((i) => i.id === place.noteId)),
    [conversations, projects, brain.items],
  )
  const nav = useNavHistory(
    {
      view: 'chat',
      conversationId: active?.id ?? null,
      projectId: active ? null : chat.activeProjectId,
      space,
      noteId: active ? null : noteId,
      createdAt: active?.createdAt,
    },
    goTo,
    placeExists,
  )
  useNavShortcuts(nav)

  // Au démarrage : on récupère les réglages, et s'il n'y a pas de clé on ouvre les paramètres.
  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s)
        // Appli : écran de connexion guidé. Web : Paramètres › Connexion, comme avant.
        if (!s.hasKey) {
          if (IS_TAURI) setOnboarding('first')
          else openSettings('connection')
        }
      })
      .catch((e) => setSettingsError(e instanceof ApiError ? e.message : 'Impossible de lire les réglages.'))
    startUpdateChecks() // appli installée seulement : y a-t-il une nouvelle version dans le repo git ?
  }, [])

  /** Changer d'espace : on quitte la conversation ouverte pour l'accueil de l'autre espace. */
  function changeSpace(next: AppSpace) {
    setMobileSidebarOpen(false)
    setNoteId(null)
    if (next === space && !active) return
    chat.newConversation(null)
    setSpace(next)
  }

  /** Ouvre une note du cerveau en pleine page (on quitte la conversation ouverte). */
  function showNote(id: string) {
    setMobileSidebarOpen(false)
    if (active) chat.newConversation(null)
    setSpace('brain')
    setNoteId(id)
  }

  /** « Nouvelle note » : la page est créée tout de suite, comme dans Notion (supprimée si on la quitte vide). */
  function newNote() {
    showNote(brain.create({ kind: 'note' }).id)
  }

  /** Nouvelle conversation : en Code, dans le projet de code ouvert (sinon l'accueil Code). */
  function newConversation() {
    const inCodeProject = space === 'code' && activeProject && projectSpace(activeProject) === 'code'
    chat.newConversation(inCodeProject ? activeProject.id : null)
  }

  /**
   * Espace Code : « Ajouter un dossier ». Appli : fenêtre de macOS, puis projet nommé comme le dossier
   * (ou le projet existant s'il y en a déjà un pour ce dossier). Web : fenêtre du projet (nom seulement).
   */
  async function addCodeProject() {
    setMobileSidebarOpen(false)
    setProjectError(null)
    if (!IS_TAURI) {
      setProjectDialog({ id: null, space: 'code' })
      return
    }
    try {
      const workspace = await pickWorkspace()
      if (!workspace) return
      const existing = codeProjects.find((p) => p.workspace === workspace)
      const project = existing ?? projects.createProject({ name: folderName(workspace), space: 'code', workspace })
      setSpace('code')
      chat.newConversation(project.id)
    } catch (e) {
      setProjectError((e as Error).message)
    }
  }

  /** Plus aucun projet n'utilise ce dossier : on retire l'autorisation côté Rust. */
  function releaseIfUnused(workspace: string | undefined, exceptId: string) {
    const used =
      projects.projects.some((p) => p.id !== exceptId && p.workspace === workspace) ||
      chat.conversations.some((c) => c.folder === workspace) // dossier joint à une conversation du Chat
    if (workspace && !used) void releaseWorkspace(workspace)
  }

  /** Sources du projet › « Ajouter au projet » : le document va dans le cerveau, rangé dans le projet (mêmes limites que dans la fenêtre du projet). */
  function addProjectFile(project: Project, file: Attachment): string | null {
    return brain.keepFile(file, project.id).error ?? null
  }

  /** « Garder dans le cerveau » sous une réponse : on garde aussi la question, pour le titre. */
  function saveReply(messageId: string, answer: string) {
    if (!active) return
    if (saveHint) dismissSaveHint()
    const index = active.messages.findIndex((m) => m.id === messageId)
    const question = active.messages.slice(0, index).findLast((m) => m.role === 'user')?.content ?? ''
    brain.saveReply({ conversationId: active.id, messageId, question, answer })
  }
  const savedIds = new Set(brain.items.flatMap((i) => (i.origin?.messageId ? [i.origin.messageId] : [])))
  // Première réponse d'une conversation, juste après la connexion : on met en avant « Garder dans le cerveau ».
  const highlightSaveId =
    saveHint && active?.messages.length === 2 && active.messages[1].role === 'assistant' ? active.messages[1].id : null

  /** « Commencer à discuter » : premier lancement → nouvelle conversation en Auto avec un premier message proposé. */
  function finishOnboarding() {
    const mode = onboarding
    setOnboarding(null)
    void models.refresh()
    setModelsVersion((v) => v + 1)
    if (mode !== 'first') return // réparation : on revient là où on était
    setNoteId(null)
    setSpace('chat')
    chat.newConversation(null)
    chat.setModel('auto', { defaultOnly: true })
    setStarter(STARTER_MESSAGE)
    setSaveHint(true)
    writeSaveHint(true)
  }

  const sidebarProps = {
    conversations: chat.conversations,
    loaded: chat.loaded,
    storageError: chat.storageError,
    activeId: active?.id ?? null,
    streamingId,
    onRename: chat.renameConversation,
    onDelete: chat.deleteConversation,
    onNew: () => {
      newConversation()
      setMobileSidebarOpen(false)
    },
    onSelect: (id: string) => {
      setNoteId(null)
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
      setNoteId(null)
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
      releaseIfUnused(projects.getProject(id)?.workspace, id)
      void projects.deleteProject(id)
      chat.detachProject(id)
      brain.detachProject(id)
    },
    onMove: chat.moveConversation,
    space,
    onSpaceChange: changeSpace,
    onAddCodeProject: () => void addCodeProject(),
    brainItems: brain.items,
    activeNoteId: openNote ? openNote.id : null,
    onNewNote: newNote,
    onOpenNote: showNote,
  }

  // /usage : petite carte au-dessus du champ (fermée en changeant de conversation).
  const [usageFor, setUsageFor] = useState<string | null>(null)
  const place = active?.id ?? `new:${chat.activeProjectId ?? ''}:${space}`
  const commands = useSlashCommands({
    chat,
    models: models.models,
    projects: projects.projects,
    newConversation,
    showUsage: () => setUsageFor(place),
    custom: prefs.commands,
    saveNote: (text) => {
      brain.quickNote(text)
    },
  })

  const composer = (
    <div className="flex flex-col gap-2">
      {usageFor === place && (
        <UsageCard
          onClose={() => setUsageFor(null)}
          onOpenDetails={() => {
            setUsageFor(null)
            openSettings('usage')
          }}
        />
      )}
      <Composer
        onSend={(text, files) => {
          if (starter) setStarter('')
          // Espace Cerveau : la question part dans une conversation du Chat, avec la recherche dans les notes.
          return space === 'brain' ? chat.send(text, files, { brain: true }) : chat.send(text, files)
        }}
        initialValue={starter}
        placeholder={space === 'brain' ? 'Demande quelque chose à ton cerveau…' : undefined}
        onStop={chat.stop}
        isStreaming={activeIsStreaming}
        busy={isStreaming && !activeIsStreaming}
        focusKey={active?.id ?? 'new'}
        modelReadsImages={isVisionModel(chat.selectedModel)}
        modelUsesTools={isToolModel(chat.selectedModel)}
        agent={space === 'code' && activeProject ? { workspace: activeProject.workspace } : null}
        // Espace Chat : on peut joindre un dossier en lecture seule à la conversation.
        {...(space === 'chat' && { folder: chat.folder, onFolderChange: chat.setFolder })}
        commands={commands}
      />
    </div>
  )
  const isEmpty = !active || active.messages.length === 0
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
      {/* Appli : écran de connexion par-dessus tout (sauf les Paramètres, ouverts depuis « Ajouter une clé fournisseur »).
          Pendant la lecture des réglages, un fond vide évite d'apercevoir le chat avant cet écran. */}
      {IS_TAURI && settings === null && !settingsError && <div className="fixed inset-0 z-40 bg-background" />}
      {onboarding && settings && (
        <div className="fixed inset-0 z-40">
          <Onboarding
            settings={settings}
            repair={onboarding === 'repair'}
            modelsVersion={modelsVersion}
            onSettingsChange={setSettings}
            onOpenKeys={() => openSettings('keys')}
            onStart={finishOnboarding}
            onCancel={onboarding === 'repair' && settings.hasKey ? () => setOnboarding(null) : undefined}
          />
        </div>
      )}
      <div inert={onboarding !== null} className="flex h-dvh bg-background text-foreground">
        {/* Grand écran : barre latérale fixe, repliable (inert = ignorée au clavier quand elle est cachée) */}
        <aside ref={asideRef} inert={!sidebarOpen} className="hidden shrink-0 overflow-hidden md:block">
          <div className="h-full w-72 border-r border-sidebar-border">
            <Sidebar {...sidebarProps} onCollapse={() => setSidebarOpen(false)} />
          </div>
        </aside>

        {/* Mobile : panneau qui glisse depuis la gauche */}
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="w-80 max-w-[85vw] gap-0 p-0">
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
              {openNote && !active && <span className="text-muted-foreground">Cerveau / </span>}
              {active?.title ??
                activeProject?.name ??
                (openNote ? itemTitle(openNote) : space === 'code' ? 'Code' : space === 'brain' ? 'Cerveau' : 'Nouvelle conversation')}
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
          {projectError && (
            <p role="alert" className="mx-4 rounded-lg bg-destructive/5 p-3 text-sm text-destructive">
              {projectError}
            </p>
          )}

          {/* Filet de sécurité : une vue qui plante ne fait pas tomber la barre latérale. On retente en changeant d'endroit. */}
          <ErrorBoundary resetKey={`${space}|${active?.id ?? ''}|${activeProject?.id ?? ''}|${noteId ?? ''}`}>
          {isEmpty && activeProject ? (
            // Accueil d'un projet : son nom, ses conversations, et une zone de saisie pour en commencer une.
            <ProjectHome
              key={activeProject.id}
              project={activeProject}
              conversations={chat.conversations.filter((c) => c.projectId === activeProject.id)}
              composer={composer}
              widthClass={widthClass}
              files={brain.projectFiles(activeProject.id)}
              onEdit={() => setProjectDialog({ id: activeProject.id })}
              onSelect={chat.selectConversation}
              onAddFile={(file) => addProjectFile(activeProject, file)}
            />
          ) : isEmpty && space === 'brain' && openNote ? (
            <BrainNotePage
              key={openNote.id}
              item={openNote}
              brain={brain}
              projects={projects.projects}
              canOpenOrigin={chat.conversations.some((c) => c.id === openNote.origin?.conversationId)}
              model={chat.selectedModel}
              onBack={() => setNoteId(null)}
              onOpenNote={showNote}
              onOpenOrigin={() => openNote.origin && chat.selectConversation(openNote.origin.conversationId)}
            />
          ) : isEmpty && space === 'brain' ? (
            <BrainHome
              brain={brain}
              tidy={tidy}
              projects={projects.projects}
              conversations={chat.conversations}
              composer={composer}
              widthClass={widthClass}
              onOpen={showNote}
              onNew={newNote}
              onSelectConversation={chat.selectConversation}
            />
          ) : isEmpty && space === 'code' ? (
            // Accueil de l'espace Code : choisir (ou ajouter) le projet sur lequel on travaille.
            <CodeHome
              projects={codeProjects}
              widthClass={widthClass}
              onOpen={(id) => chat.newConversation(id)}
              onAdd={() => void addCodeProject()}
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
                savedIds={savedIds}
                onSave={saveReply}
                onRegenerate={isStreaming ? undefined : () => void chat.regenerate()}
                onDuplicate={(messageId) => chat.duplicateFrom(active.id, messageId)}
                onEdit={(messageId, text) => chat.editMessage(active.id, messageId, text)}
                onRepair={repairConnection}
                highlightSaveId={highlightSaveId}
                onDismissSaveHint={dismissSaveHint}
              />
              <div className={cn('mx-auto w-full px-4 pb-4', widthClass)}>
                {composer}
                <p className="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
                  Entrée pour envoyer · Maj + Entrée pour aller à la ligne
                </p>
              </div>
            </>
          )}
          </ErrorBoundary>
        </div>
      </div>

      {projectDialog && (
        <ProjectDialog
          project={projectDialog.id ? (projects.getProject(projectDialog.id) ?? null) : null}
          space={projectDialog.space}
          conversations={chat.conversations}
          files={projectDialog.id ? brain.projectFiles(projectDialog.id) : []}
          onClose={() => setProjectDialog(null)}
          onForgetSummary={chat.forgetSummary}
          onSave={({ files, ...draft }) => {
            if (projectDialog.id) {
              const before = projects.getProject(projectDialog.id)?.workspace
              if (before !== draft.workspace) releaseIfUnused(before, projectDialog.id)
              projects.updateProject(projectDialog.id, draft)
              brain.setProjectFiles(projectDialog.id, files)
            } else {
              const created = projects.createProject({ ...draft, ...(projectDialog.space === 'code' && { space: 'code' as const }) })
              brain.setProjectFiles(created.id, files)
              chat.newConversation(created.id) // on ouvre le nouveau projet
            }
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
  files,
  onEdit,
  onSelect,
  onAddFile,
}: {
  project: Project
  conversations: Conversation[]
  composer: ReactNode
  widthClass: string
  /** Fichiers de référence (éléments du cerveau rangés dans le projet). */
  files: Attachment[]
  onEdit: () => void
  onSelect: (id: string) => void
  onAddFile: (file: Attachment) => string | null
}) {
  const code = projectSpace(project) === 'code'
  const details = [
    code && (project.workspace ? `dossier ${folderName(project.workspace)}` : IS_TAURI ? 'aucun dossier' : 'JavaScript seulement'),
    project.instructions.trim() && 'instructions',
    files.length > 0 && `${files.length} fichier${files.length > 1 ? 's' : ''}`,
    project.memory && 'mémoire activée',
  ].filter(Boolean)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Appear stagger={0.08} from={{ autoAlpha: 0, y: 20, duration: 0.5 }} className={cn('mx-auto flex w-full flex-col gap-6 px-4 pt-[12vh] pb-8', widthClass)}>
        <div className="flex items-center gap-3">
          <ProjectBadge project={project} className="size-12" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-2xl font-semibold">{project.name}</h2>
            <p className="truncate text-sm text-muted-foreground" title={project.workspace}>
              {details.length ? details.join(' · ') : 'Ajoute des instructions pour donner du contexte au modèle.'}
            </p>
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
        <ProjectSources
          conversations={conversations}
          knownFiles={new Set(files.map(attachmentKey))}
          onSelect={onSelect}
          onAddFile={onAddFile}
        />
      </Appear>
    </div>
  )
}

/** Accueil de l'espace Code : les projets de code (un par dossier), et de quoi en ajouter un. */
function CodeHome({
  projects,
  widthClass,
  onOpen,
  onAdd,
}: {
  projects: Project[]
  widthClass: string
  onOpen: (id: string) => void
  onAdd: () => void
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Appear stagger={0.08} from={{ autoAlpha: 0, y: 20, duration: 0.5 }} className={cn('mx-auto flex w-full flex-col gap-6 px-4 pt-[12vh] pb-8', widthClass)}>
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
            <CodeXml className="size-6" aria-hidden />
          </span>
          <h2 className="text-2xl font-semibold sm:text-3xl">Sur quoi on travaille ?</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            {IS_TAURI
              ? 'Chaque projet de code est lié à un dossier. L’agent peut le lire, y chercher et exécuter du JavaScript (sans rien modifier).'
              : 'Ici, l’agent peut exécuter du JavaScript. La lecture d’un dossier se fait dans l’appli Aery.'}
          </p>
        </div>
        {projects.length > 0 && (
          <ul aria-label="Projets de code" className="flex flex-col divide-y rounded-2xl border">
            {projects.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpen(p.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/50"
                >
                  <ProjectIcon project={p} className="size-5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{p.workspace ?? 'Aucun dossier'}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" className="h-10 self-center" onClick={onAdd}>
          <FolderPlus aria-hidden />
          {IS_TAURI ? 'Ajouter un dossier' : 'Nouveau projet de code'}
        </Button>
      </Appear>
    </div>
  )
}
