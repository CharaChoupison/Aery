import { MessageSquare, PanelLeft, SlidersHorizontal, SquarePen } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
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
import { ApiError, getSettings, type Settings } from '@/lib/api'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { ModelsPage } from '@/pages/ModelsPage'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { hasCustomModelSettings, usePreferences } from '@/lib/preferences'
import { useTheme } from '@/lib/theme'
import { startUpdateChecks } from '@/lib/updates'
import { cn } from '@/lib/utils'

/** Largeur de la barre latérale sur grand écran (w-64). */
const SIDEBAR_WIDTH = 256

/** Ce qu'affiche la zone principale : le chat, ou une page de statistiques FreeLLMAPI. */
export type View = 'chat' | 'models' | 'analytics'
const VIEW_TITLES: Record<View, string> = { chat: '', models: 'Modèles', analytics: 'Analytique' }

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [view, setView] = useState<View>('chat')
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true) // grand écran : barre dépliée ou repliée
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false) // mobile : panneau coulissant

  const prefs = usePreferences()
  const motion = useMotion()
  useTheme(prefs.theme)

  function openSettings(tab: SettingsTab) {
    setSettingsTab(tab)
    setSettingsOpen(true)
  }

  const chat = useChat({ onMissingKey: () => openSettings('connection') })
  const models = useModels(settings?.hasKey ?? false)
  const { active, activeError, isStreaming, streamingId } = chat
  const activeIsStreaming = active !== null && streamingId === active.id

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
    view,
    onNavigate: (v: View) => {
      setView(v)
      setMobileSidebarOpen(false)
    },
    onNew: () => {
      chat.newConversation()
      setView('chat')
      setMobileSidebarOpen(false)
    },
    onSelect: (id: string) => {
      chat.selectConversation(id)
      setView('chat')
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
  }

  const composer = (
    <Composer
      onSend={chat.send}
      onStop={chat.stop}
      isStreaming={activeIsStreaming}
      busy={isStreaming && !activeIsStreaming}
      focusKey={active?.id ?? 'new'}
    />
  )
  const isEmpty = !active || active.messages.length === 0
  const newConversation = () => {
    chat.newConversation()
    setView('chat')
  }
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
          <header className="flex h-14 shrink-0 items-center gap-1 px-2">
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
                <IconButton label="Nouvelle conversation" onClick={newConversation}>
                  <SquarePen className="size-5" aria-hidden />
                </IconButton>
              </Appear>
            )}
            <span className="min-w-0 truncate px-2 text-sm font-medium">
              {view === 'chat' ? (active?.title ?? 'Nouvelle conversation') : VIEW_TITLES[view]}
            </span>
            <div className={cn('ml-auto items-center gap-1', view === 'chat' ? 'flex' : 'hidden')}>
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

          {view !== 'chat' ? (
            // Pages de statistiques : elles défilent dans la zone principale.
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Appear key={view} from={{ autoAlpha: 0, y: 12 }}>
                {view === 'models' ? <ModelsPage /> : <AnalyticsPage />}
              </Appear>
            </main>
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
                <MessageSquare className="size-6" aria-hidden />
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
      />
    </TooltipProvider>
  )
}
