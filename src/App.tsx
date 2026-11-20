import { PanelLeft, SlidersHorizontal, SquarePen } from 'lucide-react'
import { AeryLogo } from '@/components/AeryLogo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Appear } from '@/components/Appear'
import { Composer } from '@/components/Composer'
import { IconButton } from '@/components/IconButton'
import { MessageList } from '@/components/MessageList'
import { ModelPicker } from '@/components/ModelPicker'
import { SettingsDialog, type SettingsTab } from '@/components/SettingsDialog'
import { Sidebar } from '@/components/Sidebar'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useChat } from '@/hooks/useChat'
import { useModels } from '@/hooks/useModels'
import { useVisionModels } from '@/hooks/useVisionModels'
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
  const chat = useChat({ onMissingKey: () => openSettings('connection'), isVisionModel })
  const models = useModels(settings?.hasKey ?? false)
  const { active, activeError, isStreaming, streamingId } = chat
  const activeIsStreaming = active !== null && streamingId === active.id

  // Précédent / Suivant : l'historique observe la page et la conversation ouvertes.
  const { selectConversation, newConversation: resetConversation, conversations } = chat
  const goTo = useCallback(
    (place: Place) => {
      if (place.conversationId) selectConversation(place.conversationId)
      else resetConversation()
    },
    [selectConversation, resetConversation],
  )
  const placeExists = useCallback(
    (place: Place) => !place.conversationId || conversations.some((c) => c.id === place.conversationId),
    [conversations],
  )
  const nav = useNavHistory(
    { view: 'chat', conversationId: active?.id ?? null },
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
              {active?.title ?? 'Nouvelle conversation'}
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

          {isEmpty ? (
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
