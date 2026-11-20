import {
  Boxes,
  ChartColumn,
  CircleAlert,
  CircleArrowUp,
  CircleCheck,
  Eye,
  EyeOff,
  Gauge,
  Info,
  KeyRound,
  LoaderCircle,
  Monitor,
  Moon,
  PlugZap,
  RefreshCw,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  SquareSlash,
  Sun,
  Trash2,
  UserRound,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Appear } from '@/components/Appear'
import { CommandsPage } from '@/components/settings/CommandsPage'
import { KeysPage } from '@/components/settings/KeysPage'
import { Group, Notice, Row, SelectControl } from '@/components/settings/layout'
import { ProfilePage } from '@/components/settings/ProfilePage'
import { UsagePage } from '@/components/settings/UsagePage'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { ModelsPage } from '@/pages/ModelsPage'
import { ApiError, listModels, saveSettings, type Settings } from '@/lib/api'
import { useMotion } from '@/lib/motion'
import {
  DEFAULT_PREFERENCES,
  LIMITS,
  setPreferences,
  usePreferences,
  type ChatWidth,
  type MotionPreference,
  type Preferences,
  type SamplingControl,
  type ThemePreference,
} from '@/lib/preferences'
import { switchTheme } from '@/lib/theme'
import { IS_TAURI } from '@/lib/transport'
import { CAN_UPDATE, checkForUpdates, startUpdate, useUpdates } from '@/lib/updates'
import { cn } from '@/lib/utils'

export type SettingsTab = 'general' | 'profile' | 'model' | 'commands' | 'connection' | 'models' | 'keys' | 'usage' | 'analytics' | 'updates'

interface Props {
  open: boolean
  tab: SettingsTab
  onTabChange: (tab: SettingsTab) => void
  settings: Settings | null
  onClose: () => void
  onSaved: (settings: Settings) => void
  /** Modèles activés / désactivés ou clés modifiées : la liste du sélecteur de modèle a pu changer. */
  onModelsChanged: () => void
}

/** Les pages de la navigation, avec des mots-clés pour la recherche. */
const PAGES: { id: SettingsTab; label: string; icon: LucideIcon; group: string; keywords: string; wide?: boolean }[] = [
  {
    id: 'general',
    label: 'Général',
    icon: SettingsIcon,
    group: 'Préférences',
    keywords: 'apparence thème sombre clair système largeur conversation animations accessibilité mouvement titre',
  },
  {
    id: 'profile',
    label: 'Personnalisation',
    icon: UserRound,
    group: 'Préférences',
    keywords: 'profil nom prénom pronoms tutoiement vouvoiement métier à propos style ton chaleur enthousiasme émojis titres listes instructions prompt système',
  },
  {
    id: 'model',
    label: 'Génération',
    icon: SlidersHorizontal,
    group: 'Préférences',
    keywords: 'réglages du modèle température top p max tokens échantillonnage historique mémoire messages',
  },
  {
    id: 'commands',
    label: 'Commandes',
    icon: SquareSlash,
    group: 'Préférences',
    keywords: 'commandes slash raccourcis prompt modèle de message perso personnalisées',
  },
  { id: 'connection', label: 'Connexion', icon: PlugZap, group: 'FreeLLMAPI', keywords: 'clé api port freellmapi tester' },
  {
    id: 'models',
    label: 'Modèles',
    icon: Boxes,
    group: 'FreeLLMAPI',
    keywords: 'modèles activer désactiver chaîne repli routeur score fiabilité vitesse intelligence vision',
    wide: true,
  },
  { id: 'keys', label: 'Clés des fournisseurs', icon: KeyRound, group: 'FreeLLMAPI', keywords: 'ajouter clé fournisseur groq google openrouter supprimer' },
  { id: 'usage', label: 'Utilisation', icon: Gauge, group: 'FreeLLMAPI', keywords: 'utilisation quota limite consommation tokens requêtes budget mois jour' },
  {
    id: 'analytics',
    label: 'Analytique',
    icon: ChartColumn,
    group: 'FreeLLMAPI',
    keywords: 'statistiques analytique requêtes latence journaux logs erreurs',
    wide: true,
  },
  // Mises à jour : seulement dans l'appli (elles reconstruisent l'appli depuis le repo git).
  ...(IS_TAURI
    ? [{ id: 'updates' as const, label: 'Mises à jour', icon: CircleArrowUp, group: 'Application', keywords: 'mise à jour version git github installer redémarrer nouveautés' }]
    : []),
]

export function SettingsDialog({ open, tab, onTabChange, settings, onClose, onSaved, onModelsChanged }: Props) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const pages = PAGES.filter((p) => !q || `${p.label} ${p.keywords}`.toLowerCase().includes(q))
  const groups = [...new Set(pages.map((p) => p.group))]
  const current = PAGES.find((p) => p.id === tab) ?? PAGES[0]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setQuery('')
          onClose()
        }
      }}
    >
      <DialogContent className="flex h-[min(46rem,calc(100dvh-7rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <div className="flex h-14 shrink-0 items-center border-b px-5">
          <DialogTitle className="text-base font-semibold">Paramètres</DialogTitle>
          <DialogDescription className="sr-only">
            Apparence, personnalisation, réglages de génération, commandes, connexion à FreeLLMAPI, modèles, clés et utilisation.
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* Navigation (en haut sur mobile, à gauche sur grand écran) */}
          <nav aria-label="Sections des paramètres" className="shrink-0 border-b p-3 sm:w-60 sm:overflow-y-auto sm:border-r sm:border-b-0">
            <div className="relative mb-3 hidden sm:block">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  // La page ouverte ne correspond plus ? On ouvre la première qui correspond.
                  const nq = e.target.value.trim().toLowerCase()
                  const match = PAGES.filter((p) => `${p.label} ${p.keywords}`.toLowerCase().includes(nq))
                  if (nq && match.length && !match.some((p) => p.id === tab)) onTabChange(match[0].id)
                }}
                placeholder="Rechercher"
                aria-label="Rechercher un réglage"
                className="h-8 border-transparent bg-muted pl-8"
              />
            </div>
            {pages.length === 0 && <p className="px-2 text-sm text-muted-foreground">Aucun réglage trouvé.</p>}
            <div className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-4 sm:overflow-visible">
              {groups.map((group) => (
                <div key={group} className="flex gap-1 sm:flex-col">
                  <p className="hidden px-2 pb-1 text-xs font-medium text-muted-foreground sm:block">{group}</p>
                  {pages
                    .filter((p) => p.group === group)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => onTabChange(p.id)}
                        aria-current={p.id === tab ? 'page' : undefined}
                        className={cn(
                          'flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                          p.id === tab ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <p.icon className="size-4" aria-hidden />
                        {p.label}
                      </button>
                    ))}
                </div>
              ))}
            </div>
          </nav>

          {/* Contenu : key = la page se rejoue (animation) quand on change de section */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-8">
            <Appear key={current.id} from={{ autoAlpha: 0, y: 8, duration: 0.3 }} className={cn(!current.wide && 'max-w-3xl')}>
              <h2 className="mb-4 text-xl font-semibold tracking-tight">{current.label}</h2>
              {current.id === 'general' && <GeneralPage />}
              {current.id === 'profile' && <ProfilePage />}
              {current.id === 'model' && <ModelPage />}
              {current.id === 'commands' && <CommandsPage />}
              {/* Recréée à chaque ouverture : la clé tapée ne reste jamais en mémoire. */}
              {current.id === 'connection' && <ConnectionPage settings={settings} onSaved={onSaved} />}
              {current.id === 'models' && <ModelsPage onChanged={onModelsChanged} />}
              {current.id === 'keys' && <KeysPage onChanged={onModelsChanged} />}
              {current.id === 'usage' && <UsagePage />}
              {current.id === 'analytics' && <AnalyticsPage />}
              {current.id === 'updates' && <UpdatesPage />}
            </Appear>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// --- Général --------------------------------------------------------------------------------

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Système', icon: Monitor },
  { value: 'light', label: 'Clair', icon: Sun },
  { value: 'dark', label: 'Sombre', icon: Moon },
]

/** Trois icônes dans une pastille (choix du thème). */
function ThemeIcons() {
  const { theme } = usePreferences()
  const motion = useMotion()
  return (
    <div role="radiogroup" aria-label="Thème" className="flex rounded-xl bg-muted p-0.5">
      {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
        const selected = theme === value
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={label}
            title={label}
            onClick={(e) => {
              if (selected) return
              const r = e.currentTarget.getBoundingClientRect()
              switchTheme(value, { animate: motion, origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
            }}
            className={cn(
              'flex size-8 items-center justify-center rounded-[10px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" aria-hidden />
          </button>
        )
      })}
    </div>
  )
}

function GeneralPage() {
  const prefs = usePreferences()
  return (
    <>
      <Group title="Apparence">
        <Row label="Thème" description="« Système » suit le mode clair ou sombre de ton Mac, en direct." control={<ThemeIcons />} />
        <Row
          label="Largeur de la conversation"
          control={
            <SelectControl<ChatWidth>
              label="Largeur de la conversation"
              value={prefs.chatWidth}
              onChange={(chatWidth) => setPreferences({ chatWidth })}
              options={[
                { value: 'narrow', label: 'Étroite' },
                { value: 'wide', label: 'Large' },
              ]}
            />
          }
        />
      </Group>

      <Group title="Accessibilité">
        <Row
          label="Animations"
          description="Réduis les animations dans l’appli, ou suis le réglage « Réduire les animations » de macOS."
          control={
            <SelectControl<MotionPreference>
              label="Animations"
              value={prefs.motion}
              onChange={(motion) => setPreferences({ motion })}
              options={[
                { value: 'system', label: 'Système' },
                { value: 'on', label: 'Activées' },
                { value: 'off', label: 'Désactivées' },
              ]}
            />
          }
        />
      </Group>

      <Group title="Conversations">
        <Row
          label="Titre automatique"
          description="Demande au modèle un titre court pour chaque nouvelle conversation (une requête de plus)."
          control={<Switch checked={prefs.autoTitle} onCheckedChange={(autoTitle) => setPreferences({ autoTitle })} aria-label="Titre automatique" />}
        />
      </Group>
    </>
  )
}

// --- Modèle (les réglages du Playground de FreeLLMAPI) ----------------------------------------

/** 0.1 + 0.2 = 0.30000000000000004 : on arrondit au pas du curseur pour l'affichage. */
function formatStep(value: number, step: number): string {
  const decimals = String(step).split('.')[1]?.length ?? 0
  return value.toFixed(decimals)
}

function ModelPage() {
  const prefs = usePreferences()

  return (
    <>
      <Group title="Échantillonnage">
        <p className="mb-1 text-sm text-muted-foreground">
          Désactivé, c’est la valeur par défaut du fournisseur qui s’applique. Seuls les réglages activés sont envoyés.
        </p>
        <SliderRow
          label="Température"
          description="Plus haut = plus créatif, plus bas = plus précis et répétable."
          control={prefs.temperature}
          limits={LIMITS.temperature}
          onChange={(temperature) => setPreferences({ temperature })}
        />
        <SliderRow
          label="Top P"
          description="Ne garde que les mots les plus probables (alternative à la température)."
          control={prefs.topP}
          limits={LIMITS.topP}
          onChange={(topP) => setPreferences({ topP })}
        />
        <Row
          label="Max tokens"
          description="Longueur maximale de la réponse. Trop bas = réponse coupée en plein milieu."
          control={
            <Switch
              checked={prefs.maxTokens.enabled}
              onCheckedChange={(enabled) => setPreferences({ maxTokens: { ...prefs.maxTokens, enabled } })}
              aria-label="Limiter la longueur des réponses"
            />
          }
        >
          {prefs.maxTokens.enabled && (
            <Appear from={{ autoAlpha: 0, y: -4 }}>
              {/* key : si la valeur change ailleurs (Réinitialiser), le champ repart de zéro. */}
              <MaxTokensInput
                key={prefs.maxTokens.value}
                value={prefs.maxTokens.value}
                onCommit={(value) => setPreferences({ maxTokens: { ...prefs.maxTokens, value } })}
              />
            </Appear>
          )}
        </Row>
      </Group>

      <Group title="Mémoire">
        <Row
          label="Messages envoyés au modèle"
          description="Les plus récents. Les modèles gratuits ont souvent une petite fenêtre de contexte."
          control={<span className="font-mono text-sm tabular-nums">{prefs.historyLimit}</span>}
        >
          <Slider
            value={[prefs.historyLimit]}
            min={LIMITS.historyLimit.min}
            max={LIMITS.historyLimit.max}
            step={LIMITS.historyLimit.step}
            onValueChange={(v) => setPreferences({ historyLimit: Array.isArray(v) ? v[0] : (v as number) })}
            aria-label="Messages envoyés au modèle"
          />
        </Row>
      </Group>

      <Button variant="outline" onClick={() => setPreferences(resetModelSettings())}>
        <RotateCcw aria-hidden />
        Réinitialiser les réglages de génération
      </Button>
    </>
  )
}

function resetModelSettings(): Partial<Preferences> {
  const { temperature, topP, maxTokens, historyLimit } = DEFAULT_PREFERENCES
  return { temperature, topP, maxTokens, historyLimit }
}

function SliderRow({
  label,
  description,
  control,
  limits,
  onChange,
}: {
  label: string
  description: string
  control: SamplingControl
  limits: { min: number; max: number; step: number }
  onChange: (control: SamplingControl) => void
}) {
  return (
    <Row
      label={label}
      description={description}
      control={
        <span className="flex items-center gap-3">
          <span className={cn('w-12 text-right text-sm', control.enabled ? 'font-mono tabular-nums' : 'text-muted-foreground')}>
            {control.enabled ? formatStep(control.value, limits.step) : 'Défaut'}
          </span>
          <Switch checked={control.enabled} onCheckedChange={(enabled) => onChange({ ...control, enabled })} aria-label={`Activer : ${label}`} />
        </span>
      }
    >
      {control.enabled && (
        <Appear from={{ autoAlpha: 0, y: -4 }}>
          <Slider
            value={[control.value]}
            min={limits.min}
            max={limits.max}
            step={limits.step}
            onValueChange={(v) => onChange({ ...control, value: Array.isArray(v) ? v[0] : (v as number) })}
            aria-label={label}
          />
        </Appear>
      )}
    </Row>
  )
}

/** Champ avec brouillon local : on peut le vider pendant la saisie, la valeur n'est validée qu'à la fin. */
function MaxTokensInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const { min, max } = LIMITS.maxTokens
  const [draft, setDraft] = useState(String(value))

  function commit() {
    const n = Math.round(Number(draft))
    if (draft.trim() !== '' && Number.isFinite(n) && n >= min) onCommit(Math.min(n, max))
    else setDraft(String(value))
  }

  return (
    <Input
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          commit()
        }
      }}
      aria-label="Max tokens"
      className="h-9 w-40"
    />
  )
}

// --- Connexion ------------------------------------------------------------------------------

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }

function ConnectionPage({ settings, onSaved }: { settings: Settings | null; onSaved: (settings: Settings) => void }) {
  const [key, setKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [port, setPort] = useState(String(settings?.port ?? 31415))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  async function testConnection(): Promise<void> {
    try {
      const models = await listModels()
      setStatus({ kind: 'ok', text: `Connexion OK : ${models.length} modèles disponibles.` })
    } catch (e) {
      setStatus({ kind: 'error', text: e instanceof ApiError ? e.message : 'Test impossible.' })
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault()
    const portNumber = Number(port)
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      setStatus({ kind: 'error', text: 'Le port doit être un nombre entre 1 et 65535.' })
      return
    }
    setStatus({ kind: 'busy' })
    try {
      const trimmed = key.trim()
      const saved = await saveSettings({ port: portNumber, ...(trimmed ? { apiKey: trimmed } : {}) })
      setKey('')
      setShowKey(false)
      onSaved(saved)
      if (saved.hasKey) await testConnection()
      else setStatus({ kind: 'ok', text: 'Enregistré.' })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Erreur à l’enregistrement.' })
    }
  }

  async function handleDeleteKey() {
    if (!confirm('Supprimer la clé enregistrée ?')) return
    try {
      onSaved(await saveSettings({ apiKey: null }))
      setStatus({ kind: 'ok', text: 'Clé supprimée.' })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Suppression impossible.' })
    }
  }

  const looksWrong = key.trim() !== '' && !key.trim().startsWith('freellmapi-')

  return (
    <form onSubmit={handleSave}>
      <Group title="FreeLLMAPI">
        {!settings?.hasKey && (
          <Notice tone="warning" icon={Info}>
            Colle ta clé FreeLLMAPI pour commencer. Tu la trouves dans le dashboard de l’appli desktop.
          </Notice>
        )}

        <Row
          label="Clé FreeLLMAPI"
          description={
            settings?.hasKey
              ? `Actuelle : ${settings.keyHint}. Laisse vide pour la garder.`
              : IS_TAURI
                ? 'Stockée dans le Trousseau macOS, jamais renvoyée à l’interface.'
                : 'Stockée sur ton ordi dans ~/.freellm-chat/, jamais renvoyée au navigateur.'
          }
        >
          <div className="flex gap-2">
            <Input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="freellmapi-…"
              autoComplete="off"
              spellCheck={false}
              aria-label="Clé FreeLLMAPI"
              className="h-9 font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="icon-lg"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? 'Masquer la clé' : 'Afficher la clé'}
              title={showKey ? 'Masquer la clé' : 'Afficher la clé'}
            >
              {showKey ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            </Button>
          </div>
          {looksWrong && (
            <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-400">
              Hmm, une clé FreeLLMAPI commence normalement par « freellmapi- ».
            </p>
          )}
        </Row>

        <Row
          label="Port"
          description="31415 par défaut. Vérifie le port affiché dans l’appli FreeLLMAPI."
          control={
            <Input
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              aria-label="Port de FreeLLMAPI"
              className="h-9 w-28"
            />
          }
        />
      </Group>

      {status.kind === 'ok' && (
        <Notice tone="success" icon={CircleCheck}>
          {status.text}
        </Notice>
      )}
      {status.kind === 'error' && (
        <Notice tone="error" icon={CircleAlert}>
          {status.text}
        </Notice>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {settings?.hasKey ? (
          <Button type="button" variant="ghost" onClick={handleDeleteKey} className="h-9 text-destructive hover:text-destructive">
            <Trash2 aria-hidden />
            Supprimer la clé
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          {settings?.hasKey && (
            <Button
              type="button"
              variant="outline"
              className="h-9 px-4"
              onClick={() => {
                setStatus({ kind: 'busy' })
                void testConnection()
              }}
            >
              Tester
            </Button>
          )}
          <Button type="submit" disabled={status.kind === 'busy'} className="h-9 min-w-28 px-4">
            {status.kind === 'busy' ? <LoaderCircle className="animate-spin" aria-label="Chargement" /> : 'Enregistrer'}
          </Button>
        </div>
      </div>

      <Group title="Accès à FreeLLMAPI">
        <Row
          label="Modèles, clés, utilisation et analytique"
          description="Ces pages passent par la session de l’appli desktop FreeLLMAPI. Le chat peut seulement lire les statistiques, activer ou désactiver un modèle, et ajouter ou supprimer une clé de fournisseur. Il ne peut ni afficher une clé en clair, ni toucher aux autres réglages."
        />
      </Group>
    </form>
  )
}

// --- Mises à jour -------------------------------------------------------------------------

function UpdatesPage() {
  const { status, checking, checkError, lastChecked, running, step, runError } = useUpdates()

  // À l'ouverture de la page : on revérifie, sauf si on vient de le faire.
  useEffect(() => {
    if (!lastChecked || Date.now() - lastChecked > 60_000) void checkForUpdates()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const installed = status ? (
    status.installed ? (
      <>
        Commit <code className="font-mono text-xs">{status.installed}</code>
      </>
    ) : (
      'Inconnue : l’appli n’a pas été installée avec npm run app:install.'
    )
  ) : checking ? (
    'Vérification…'
  ) : (
    'Pas encore vérifiée.'
  )

  const n = status?.commits.length ?? 0
  const summary = !status
    ? null
    : !status.available
      ? 'Tout est à jour.'
      : n > 0
        ? `${n} nouveauté${n > 1 ? 's' : ''} depuis ta version.`
        : `Une nouvelle version (commit ${status.latest}) peut être construite.`

  return (
    <>
      <Group title="Mises à jour">
        <Row
          label="Version installée"
          description={installed}
          control={
            <Button variant="outline" className="h-9 px-3" onClick={() => void checkForUpdates()} disabled={checking || running}>
              <RefreshCw className={cn(checking && 'animate-spin')} aria-hidden />
              Vérifier
            </Button>
          }
        />
        {status && (
          <Row
            label={status.available ? 'Mise à jour disponible' : 'État'}
            description={summary}
            control={
              running ? (
                <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  {step ?? 'Mise à jour'}…
                </span>
              ) : status.available ? (
                <Button className="h-9 px-4" onClick={() => void startUpdate()} disabled={!CAN_UPDATE || status.blocked !== null}>
                  Mettre à jour
                </Button>
              ) : undefined
            }
          >
            {n > 0 && (
              <ul className="max-h-56 overflow-y-auto rounded-lg bg-muted/50 p-2 text-sm">
                {status.commits.map((c) => (
                  <li key={c.hash} className="flex gap-3 rounded-md px-2 py-1.5">
                    <code className="shrink-0 font-mono text-xs leading-5 text-muted-foreground">{c.hash}</code>
                    <span className="min-w-0">{c.summary}</span>
                  </li>
                ))}
              </ul>
            )}
          </Row>
        )}
        <Row
          label="Comment ça marche"
          description="L’appli compare sa version avec ton repo git et avec GitHub, au lancement puis toutes les 6 heures. « Mettre à jour » récupère les nouveautés (git pull), reconstruit l’appli puis la relance. Tes conversations et ta clé sont conservées."
        />
      </Group>

      {running && (
        <Notice tone="warning" icon={Info}>
          Ça prend en général une à deux minutes, puis l’appli redémarre toute seule. Une réponse en cours d’écriture à ce
          moment-là serait coupée.
        </Notice>
      )}
      {!CAN_UPDATE && (
        <Notice tone="warning" icon={Info}>
          En mode dev (npm run app:dev), le bouton est désactivé : il sert à l’appli installée dans Applications.
        </Notice>
      )}
      {status?.blocked && (
        <Notice tone="warning" icon={Info}>
          {status.blocked}
        </Notice>
      )}
      {status?.warnings.map((w) => (
        <Notice key={w} tone="warning" icon={Info}>
          {w}
        </Notice>
      ))}
      {checkError && (
        <Notice tone="error" icon={CircleAlert}>
          Vérification impossible : {checkError}
        </Notice>
      )}
      {runError && (
        <Notice tone="error" icon={CircleAlert}>
          <span className="block font-mono text-xs break-words whitespace-pre-wrap">{runError}</span>
        </Notice>
      )}
    </>
  )
}
