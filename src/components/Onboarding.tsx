import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  PlugZap,
  RotateCcw,
  Sparkles,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AeryLogo } from '@/components/AeryLogo'
import { Appear } from '@/components/Appear'
import { Notice } from '@/components/settings/layout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateKeyless, getKeys, getProviders, keylessToActivate, type Provider } from '@/lib/admin'
import { ApiError, listModels, saveSettings, type Settings } from '@/lib/api'
import {
  connectFreellm,
  getFreellmStatus,
  isRealChatModel,
  openFreellm,
  openFreellmDownload,
  type FreellmStatus,
} from '@/lib/onboarding'
import { dragRegion, TRAFFIC_LIGHTS_INSET, useTrafficLights } from '@/lib/titlebar'
import { cn } from '@/lib/utils'

/** Où en est la connexion. Une seule action principale par état. */
type Phase =
  | { step: 'checking' }
  | { step: 'starting'; port: number }
  | { step: 'missing' }
  | { step: 'unreachable'; port: number }
  | { step: 'key' }
  | { step: 'models' }
  | { step: 'noModels'; keyless: Provider[] | null }
  | { step: 'ready'; count: number }

interface Props {
  settings: Settings
  /** true = ouvert depuis « Réparer la connexion » (une clé existe peut-être déjà) : on peut annuler. */
  repair?: boolean
  /** Incrémenté quand des fournisseurs / modèles changent ailleurs (Paramètres › Clés) : on revérifie. */
  modelsVersion: number
  onSettingsChange: (settings: Settings) => void
  onOpenKeys: () => void
  onStart: () => void
  onCancel?: () => void
}

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError || e instanceof Error ? e.message || fallback : fallback)

/**
 * Premier lancement (appli seulement) : FreeLLMAPI → clé → modèle disponible → chat.
 * Si FreeLLMAPI est déjà installée et qu'un modèle répond, il ne reste qu'à coller la clé.
 */
export function Onboarding({ settings, repair = false, modelsVersion, onSettingsChange, onOpenKeys, onStart, onCancel }: Props) {
  const [phase, setPhase] = useState<Phase>({ step: 'checking' })
  const [port, setPort] = useState(settings.port)
  const [keyHint, setKeyHint] = useState<string | null>(settings.hasKey ? settings.keyHint : null)
  const [notice, setNotice] = useState<string | null>(null) // erreur générale (sous l'action)
  const trafficLights = useTrafficLights()

  // Une vérification plus récente annule les résultats des précédentes.
  const runRef = useRef(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  /** La clé est enregistrée : y a-t-il un vrai modèle de chat utilisable ? */
  const checkModels = useCallback(
    async (options: { retries?: number } = {}) => {
      const run = ++runRef.current
      setPhase({ step: 'models' })
      setNotice(null)
      for (let attempt = 0; ; attempt++) {
        try {
          const count = (await listModels()).filter(isRealChatModel).length
          if (run !== runRef.current) return
          if (count > 0) return setPhase({ step: 'ready', count })
        } catch (e) {
          if (run !== runRef.current) return
          if (e instanceof ApiError && (e.status === 401 || e.status === 403 || e.code === 'no_key')) {
            setKeyHint(null)
            setPhase({ step: 'key' })
            if (settingsRef.current.hasKey) setNotice('FreeLLMAPI refuse la clé enregistrée. Colle celle affichée par FreeLLMAPI.')
            return
          }
          setNotice(errorText(e, 'Impossible de lister les modèles.'))
          return setPhase({ step: 'noModels', keyless: null })
        }
        // Un fournisseur tout juste activé met parfois quelques secondes à proposer ses modèles.
        if (attempt >= (options.retries ?? 0)) break
        await new Promise((r) => setTimeout(r, 2000))
        if (run !== runRef.current) return
      }
      // Aucun modèle : quels fournisseurs sans compte peut-on proposer ? (null = on ne sait pas)
      const keyless = await Promise.all([getProviders(), getKeys()])
        .then(([providers, keys]) => keylessToActivate(providers, keys, 'chat'))
        .catch(() => null)
      if (run === runRef.current) setPhase({ step: 'noModels', keyless })
    },
    [],
  )

  /** FreeLLMAPI répond sur `found` : on garde ce port, puis clé (ou modèles si une clé existe). */
  const onReachable = useCallback(
    async (status: FreellmStatus, run: number) => {
      setPort(status.port)
      const current = settingsRef.current
      if (!current.hasKey) return setPhase({ step: 'key' })
      // Une clé existe déjà (réparation) : si le port a changé, on l'enregistre avant de la tester.
      if (status.port !== current.port) {
        try {
          onSettingsChange(await saveSettings({ port: status.port }))
        } catch (e) {
          if (run === runRef.current) setNotice(errorText(e, 'Impossible d’enregistrer le port.'))
        }
      }
      if (run === runRef.current) void checkModels()
    },
    [checkModels, onSettingsChange],
  )

  /** Trouver FreeLLMAPI (port enregistré, 31415, puis détection), la démarrer si besoin. */
  const detect = useCallback(
    async (manualPort?: number) => {
      const run = ++runRef.current
      setNotice(null)
      setPhase({ step: 'checking' })
      try {
        const first = await getFreellmStatus({ port: manualPort, launch: false })
        if (run !== runRef.current) return
        if (first.reachable) return void onReachable(first, run)
        if (!first.installed) return setPhase({ step: 'missing' })

        setPhase({ step: 'starting', port: first.port })
        const second = await getFreellmStatus({ port: manualPort, launch: true })
        if (run !== runRef.current) return
        if (second.reachable) return void onReachable(second, run)
        setPort(second.port)
        setPhase(second.installed ? { step: 'unreachable', port: second.port } : { step: 'missing' })
      } catch (e) {
        if (run !== runRef.current) return
        setNotice(errorText(e, 'Vérification impossible.'))
        setPhase({ step: 'unreachable', port: manualPort ?? settingsRef.current.port })
      }
    },
    [onReachable],
  )

  useEffect(() => {
    const runs = runRef
    void detect()
    return () => {
      runs.current++ // démonté : on ignore les réponses en vol
    }
  }, [detect])

  // Clé de fournisseur ajoutée dans Paramètres › Clés : on revérifie les modèles.
  const firstVersion = useRef(modelsVersion)
  useEffect(() => {
    if (modelsVersion !== firstVersion.current && phase.step === 'noModels') void checkModels({ retries: 2 })
    // phase.step volontairement absent : on ne revérifie que sur un vrai changement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelsVersion])

  const done = {
    freellm: ['key', 'models', 'noModels', 'ready'].includes(phase.step),
    key: ['models', 'noModels', 'ready'].includes(phase.step),
    model: phase.step === 'ready',
  }

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header {...dragRegion} className={cn('flex h-12 shrink-0 items-center px-3 select-none', trafficLights && TRAFFIC_LIGHTS_INSET)}>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} className="ml-auto">
            <X aria-hidden />
            Annuler
          </Button>
        )}
      </header>

      <main className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-[6vh] pb-12">
        <Appear stagger={0.08} from={{ autoAlpha: 0, y: 16, duration: 0.5 }} className="flex w-full max-w-md flex-col items-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
            <AeryLogo className="size-6" aria-hidden />
          </span>
          <h1 className="mt-5 text-center text-2xl font-semibold">{repair ? 'Réparer la connexion' : 'Connecter FreeLLMAPI'}</h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Aery passe par FreeLLMAPI, qui tourne sur ton Mac, pour discuter avec des modèles gratuits.
          </p>

          <ol className="mt-6 flex w-full items-center justify-center gap-2 text-xs" aria-label="Étapes">
            <StepDot label="FreeLLMAPI" done={done.freellm} current={!done.freellm} />
            <StepLine done={done.freellm} />
            <StepDot label="Clé" done={done.key} current={phase.step === 'key'} />
            <StepLine done={done.key} />
            <StepDot label="Modèle" done={done.model} current={phase.step === 'models' || phase.step === 'noModels'} />
          </ol>
        </Appear>

        <Appear
          key={phase.step}
          from={{ autoAlpha: 0, y: 10, duration: 0.4 }}
          className="mt-6 w-full max-w-md rounded-2xl border bg-card p-5 shadow-sm"
          aria-live="polite"
        >
          {phase.step === 'checking' && <Waiting title="Recherche de FreeLLMAPI…" />}

          {phase.step === 'starting' && (
            <Waiting
              title="Démarrage de FreeLLMAPI…"
              text={`Aery lance l’appli en arrière-plan et attend qu’elle réponde sur le port ${phase.port}. Ça peut prendre jusqu’à 25 secondes.`}
            />
          )}

          {phase.step === 'missing' && (
            <Panel
              icon={Download}
              title="FreeLLMAPI n’est pas installée"
              text="Télécharge l’appli pour macOS (le fichier .dmg de la dernière version), glisse-la dans Applications et ouvre-la une fois. Puis reviens ici."
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button className="h-9 flex-1" onClick={() => void openFreellmDownload().catch(() => {})}>
                  <Download aria-hidden />
                  Télécharger FreeLLMAPI
                </Button>
                <Button variant="outline" className="h-9 flex-1" onClick={() => void detect()}>
                  <RotateCcw aria-hidden />
                  Réessayer
                </Button>
              </div>
            </Panel>
          )}

          {phase.step === 'unreachable' && (
            <Panel
              icon={PlugZap}
              title="FreeLLMAPI ne répond pas"
              text={`L’appli est installée, mais son serveur ne répond pas sur le port ${phase.port}. Ouvre-la pour vérifier qu’elle a bien démarré et quel port elle affiche.`}
            >
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  className="h-9 flex-1"
                  onClick={() => {
                    void openFreellm().catch(() => {})
                    // Laisse-lui le temps de démarrer, puis on revérifie.
                    setTimeout(() => void detect(), 1500)
                  }}
                >
                  Ouvrir FreeLLMAPI
                </Button>
                <Button variant="outline" className="h-9 flex-1" onClick={() => void detect()}>
                  <RotateCcw aria-hidden />
                  Réessayer
                </Button>
              </div>
              <AdvancedPort port={port} onTry={(p) => void detect(p)} />
            </Panel>
          )}

          {phase.step === 'key' && (
            <KeyStep
              port={port}
              onConnected={(hint, savedPort) => {
                setKeyHint(hint)
                setPort(savedPort)
                onSettingsChange({ hasKey: true, keyHint: hint, port: savedPort })
                void checkModels({ retries: 1 })
              }}
              onUnreachable={() => void detect()}
              onTryPort={(p) => void detect(p)}
            />
          )}

          {phase.step === 'models' && <Waiting title="Recherche d’un modèle disponible…" />}

          {phase.step === 'noModels' && (
            <NoModelsStep keyless={phase.keyless} onOpenKeys={onOpenKeys} onRecheck={(retries) => void checkModels({ retries })} />
          )}

          {phase.step === 'ready' && (
            <Panel
              icon={Sparkles}
              title="Tout est prêt"
              text={`${phase.count} modèle${phase.count > 1 ? 's' : ''} disponible${phase.count > 1 ? 's' : ''}. En mode Auto, FreeLLMAPI choisit le meilleur pour chaque message.`}
            >
              <Button className="h-10 w-full text-sm" onClick={onStart}>
                Commencer à discuter
                <ArrowRight aria-hidden />
              </Button>
            </Panel>
          )}

          {notice && (
            <Notice tone="error" icon={CircleAlert}>
              {notice}
            </Notice>
          )}
        </Appear>

        {keyHint && done.key && (
          <p className="mt-4 flex items-center gap-1.5 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" aria-hidden />
            Clé enregistrée dans le Trousseau macOS : <code className="font-mono">{keyHint}</code> · port {port}
          </p>
        )}
      </main>
    </div>
  )
}

// --- Étapes ----------------------------------------------------------------------------

function KeyStep({
  port,
  onConnected,
  onUnreachable,
  onTryPort,
}: {
  port: number
  onConnected: (keyHint: string | null, port: number) => void
  onUnreachable: () => void
  onTryPort: (port: number) => void
}) {
  const [key, setKey] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy || key.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      const result = await connectFreellm(key, port)
      if (result.status === 'ok') {
        setKey('') // la clé ne reste pas dans l'interface
        return onConnected(result.keyHint, result.port)
      }
      if (result.status === 'unreachable') return onUnreachable()
      setError(result.message)
      inputRef.current?.select()
    } catch (err) {
      setError(errorText(err, 'Connexion impossible.'))
    } finally {
      setBusy(false)
    }
  }

  const errorId = 'onboarding-key-error'
  const looksWrong = key.trim() !== '' && !key.trim().startsWith('freellmapi-')

  return (
    <form onSubmit={submit}>
      <Panel
        icon={KeyRound}
        title="Colle ta clé FreeLLMAPI"
        text="Dans la barre des menus du Mac, clique sur l’icône FreeLLMAPI, choisis Copy Key, puis colle la clé ici."
      >
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            type={show ? 'text' : 'password'}
            value={key}
            onChange={(e) => {
              setKey(e.target.value)
              setError(null)
            }}
            placeholder="freellmapi-…"
            autoComplete="off"
            spellCheck={false}
            aria-label="Clé FreeLLMAPI"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            className="h-9 font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Masquer la clé' : 'Afficher la clé'}
            title={show ? 'Masquer la clé' : 'Afficher la clé'}
          >
            {show ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          </Button>
        </div>
        {error ? (
          <p id={errorId} role="alert" className="-mt-1 flex gap-1.5 text-xs text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        ) : (
          looksWrong && (
            <p className="-mt-1 text-xs text-amber-700 dark:text-amber-400">
              Hmm, une clé FreeLLMAPI commence normalement par « freellmapi- ».
            </p>
          )
        )}
        <Button type="submit" className="h-9 w-full" disabled={busy || key.trim() === ''}>
          {busy ? <LoaderCircle className="animate-spin" aria-hidden /> : null}
          {busy ? 'Vérification…' : 'Connecter'}
        </Button>
        <p className="text-xs text-muted-foreground">
          FreeLLMAPI répond sur le port {port}. La clé est testée, puis rangée dans le Trousseau macOS.
        </p>
        <AdvancedPort port={port} onTry={onTryPort} />
      </Panel>
    </form>
  )
}

function NoModelsStep({
  keyless,
  onOpenKeys,
  onRecheck,
}: {
  keyless: Provider[] | null
  onOpenKeys: () => void
  onRecheck: (retries: number) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canActivate = keyless !== null && keyless.length > 0

  async function activate() {
    if (!keyless) return
    setBusy(true)
    setError(null)
    const errors = await activateKeyless(keyless)
    setBusy(false)
    if (errors.length === keyless.length) return setError(errors.join(' · '))
    onRecheck(4) // les modèles des nouveaux fournisseurs peuvent mettre quelques secondes à arriver
  }

  return (
    <Panel
      icon={Sparkles}
      title="Clé acceptée, mais aucun modèle disponible"
      text={
        canActivate
          ? 'FreeLLMAPI a besoin d’au moins un fournisseur de chat. Le plus simple : activer ceux qui marchent sans compte (gratuits, avec des limites plus serrées).'
          : 'FreeLLMAPI a besoin d’au moins un fournisseur de chat. Ajoute la clé gratuite d’un fournisseur (Groq, Google AI Studio, OpenRouter…), puis reviens ici.'
      }
    >
      {canActivate && (
        <>
          <Button className="h-9 w-full" onClick={() => void activate()} disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" aria-hidden />}
            Activer les fournisseurs sans compte ({keyless.length})
          </Button>
          <p className="-mt-1 text-xs text-muted-foreground">{keyless.map((p) => p.name).join(', ')}</p>
        </>
      )}
      {error && (
        <p role="alert" className="flex gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button variant={canActivate ? 'outline' : 'default'} className="h-9 flex-1" onClick={onOpenKeys} disabled={busy}>
          <KeyRound aria-hidden />
          Ajouter une clé fournisseur
        </Button>
        <Button variant="outline" className="h-9 flex-1" onClick={() => onRecheck(0)} disabled={busy}>
          <RotateCcw aria-hidden />
          Revérifier
        </Button>
      </div>
    </Panel>
  )
}

// --- Briques -------------------------------------------------------------------------

function Panel({ icon: Icon, title, text, children }: { icon: typeof KeyRound; title: string; text: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 className="font-medium">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>
        </div>
      </div>
      {children}
    </div>
  )
}

function Waiting({ title, text }: { title: string; text?: string }) {
  return (
    <div className="flex items-start gap-3" role="status">
      <LoaderCircle className="mt-0.5 size-5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      <div>
        <p className="font-medium">{title}</p>
        {text && <p className="mt-0.5 text-sm text-muted-foreground">{text}</p>}
      </div>
    </div>
  )
}

/** Options avancées : essayer un autre port (FreeLLMAPI en prend un autre si 31415 est occupé). */
function AdvancedPort({ port, onTry }: { port: number; onTry: (port: number) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(String(port))
  const number = Number(value)
  const valid = Number.isInteger(number) && number >= 1 && number <= 65535

  return (
    <div className="border-t pt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronDown className={cn('size-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
        Options avancées
      </button>
      {open && (
        <div className="mt-3 flex items-end gap-2">
          <label className="flex-1 text-xs text-muted-foreground">
            Port de FreeLLMAPI (31415 par défaut, celui affiché dans l’appli)
            <Input
              type="number"
              min={1}
              max={65535}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="mt-1 h-9 w-full"
            />
          </label>
          <Button type="button" variant="outline" className="h-9" disabled={!valid} onClick={() => onTry(number)}>
            Essayer ce port
          </Button>
        </div>
      )}
    </div>
  )
}

function StepDot({ label, done, current }: { label: string; done: boolean; current: boolean }) {
  return (
    <li className="flex items-center gap-1.5" aria-current={current ? 'step' : undefined}>
      <span
        className={cn(
          'flex size-5 items-center justify-center rounded-full border text-[0.65rem]',
          done ? 'border-primary bg-primary text-primary-foreground' : current ? 'border-primary text-primary' : 'text-muted-foreground',
        )}
      >
        {done ? <Check className="size-3" aria-hidden /> : <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      </span>
      <span className={cn(done || current ? 'text-foreground' : 'text-muted-foreground')}>
        {label}
        {done && <span className="sr-only"> (fait)</span>}
      </span>
    </li>
  )
}

function StepLine({ done }: { done: boolean }) {
  return <li aria-hidden className={cn('h-px w-6 sm:w-10', done ? 'bg-primary' : 'bg-border')} />
}
