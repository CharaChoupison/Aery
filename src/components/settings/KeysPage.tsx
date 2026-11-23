import { CircleAlert, CircleCheck, Eye, EyeOff, Globe, Info, KeyRound, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Badge, RefreshButton } from '@/components/page'
import { Group, Notice, Row } from '@/components/settings/layout'
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
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxTrigger,
} from '@/components/ui/combobox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAdminData } from '@/hooks/useAdminData'
import { activateKeyless, addKey, deleteKey, formatCompact, formatNumber, getKeys, getProviders, keylessToActivate, type Provider, type ProviderKey } from '@/lib/admin'
import { ApiError, listSearchEngines, type SearchEngine } from '@/lib/api'
import { cn } from '@/lib/utils'

const STATUS: Record<string, { label: string; className?: string }> = {
  healthy: { label: 'Valide', className: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' },
  unknown: { label: 'Pas encore vérifiée' },
  invalid: { label: 'Invalide', className: 'bg-destructive/10 text-destructive' },
  rate_limited: { label: 'Limite atteinte', className: 'bg-amber-500/10 text-amber-800 dark:text-amber-300' },
  error: { label: 'Erreur', className: 'bg-destructive/10 text-destructive' },
}

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'warning'; text: string } | { kind: 'error'; text: string }

/**
 * Clés des fournisseurs (Groq, Google, OpenRouter…) et des moteurs de recherche web (Tavily, Exa…)
 * enregistrées dans FreeLLMAPI.
 * La clé tapée part directement vers FreeLLMAPI (via notre proxy) : le chat ne la garde nulle part,
 * et FreeLLMAPI ne la renvoie jamais en clair (seulement masquée : « gsk_…ab12 »).
 */
export function KeysPage({ onChanged }: { onChanged: () => void }) {
  const providers = useAdminData((s) => getProviders(s), [])
  const keys = useAdminData((s) => getKeys(s), [])
  // Moteurs de recherche actifs (null = on ne sait pas : on n'affiche alors aucun avertissement).
  const engines = useAdminData((s) => listSearchEngines(s).catch(() => null), [])
  const [pendingDelete, setPendingDelete] = useState<ProviderKey | null>(null)
  const [deleteStatus, setDeleteStatus] = useState<Status>({ kind: 'idle' })

  const names = useMemo(() => new Map((providers.data ?? []).map((p) => [p.platform, p.name])), [providers.data])
  const reload = () => {
    providers.reload()
    keys.reload()
    engines.reload()
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const key = pendingDelete
    setPendingDelete(null)
    try {
      await deleteKey(key.id)
      setDeleteStatus({ kind: 'ok', text: `Clé ${names.get(key.platform) ?? key.platform} supprimée.` })
      reload()
      onChanged()
    } catch (e) {
      setDeleteStatus({ kind: 'error', text: e instanceof ApiError ? e.message : 'Suppression impossible.' })
    }
  }

  const error = providers.error ?? keys.error
  // Les clés « anonymes » (fournisseurs sans clé) n'ont rien à afficher ni à supprimer : on les met à part.
  const realKeys = (keys.data ?? []).filter((k) => !k.keyless)
  const keylessCount = (keys.data ?? []).filter((k) => k.keyless).length

  return (
    <>
      <AddKeyForm providers={providers.data ?? []} engines={engines.data ?? null} onAdded={() => (reload(), onChanged())} />

      <Group
        title="Tes clés"
        description="Enregistrées et chiffrées dans FreeLLMAPI. Elles ne sont jamais affichées en clair."
        action={<RefreshButton loading={keys.loading} onClick={reload} />}
      >
        {error && (
          <Notice tone="error" icon={CircleAlert}>
            {error}
          </Notice>
        )}
        {deleteStatus.kind === 'ok' && (
          <Notice tone="success" icon={CircleCheck}>
            {deleteStatus.text}
          </Notice>
        )}
        {deleteStatus.kind === 'error' && (
          <Notice tone="error" icon={CircleAlert}>
            {deleteStatus.text}
          </Notice>
        )}
        {keys.data && realKeys.length === 0 && (
          <p className="py-4 text-sm text-muted-foreground">Aucune clé pour l’instant : ajoute la première ci-dessus.</p>
        )}
        {realKeys.map((k) => {
          const status = STATUS[k.status] ?? { label: k.status }
          return (
            <Row
              key={k.id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{names.get(k.platform) ?? k.platform}</span>
                  {k.label && <span className="text-muted-foreground">{k.label}</span>}
                  <Badge className={status.className}>{status.label}</Badge>
                  {!k.enabled && <Badge>Désactivée</Badge>}
                </span>
              }
              description={
                <span className="flex flex-wrap gap-x-3">
                  <code className="font-mono text-xs leading-5">{k.maskedKey}</code>
                  <span>
                    Ce mois-ci : {formatNumber(k.monthlyUsage.requests)} requête{k.monthlyUsage.requests > 1 ? 's' : ''},{' '}
                    {formatCompact(k.monthlyUsage.tokens)} tokens
                  </span>
                  {k.lastHealthError && k.status !== 'healthy' && <span className="text-destructive">{k.lastHealthError}</span>}
                </span>
              }
              control={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => setPendingDelete(k)}
                  aria-label={`Supprimer la clé ${names.get(k.platform) ?? k.platform}`}
                  title="Supprimer la clé"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 aria-hidden />
                </Button>
              }
            />
          )
        })}
        {keylessCount > 0 && (
          <p className="pt-3 text-xs text-muted-foreground">
            + {keylessCount} fournisseur{keylessCount > 1 ? 's' : ''} utilisé{keylessCount > 1 ? 's' : ''} sans clé (voir ci-dessous).
          </p>
        )}
        {engines.data && <SearchSummary engines={engines.data} />}
      </Group>

      <KeylessGroup
        providers={providers.data ?? []}
        keys={keys.data ?? []}
        engines={engines.data ?? null}
        onChanged={() => (reload(), onChanged())}
      />

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette clé ?</AlertDialogTitle>
            <AlertDialogDescription>
              La clé {pendingDelete && (names.get(pendingDelete.platform) ?? pendingDelete.platform)} ({pendingDelete?.maskedKey}) sera
              retirée de FreeLLMAPI. Ses modèles ne seront plus utilisables tant que tu n’en remets pas une.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Supprimer
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// --- Fournisseurs sans clé -------------------------------------------------------------

/** Fournisseurs très lents : prévenir, car `auto` peut tomber dessus. */
const SLOW_PLATFORMS = /horde/i

/**
 * Fournisseurs qui marchent sans compte (accès anonyme, limites plus serrées).
 * Pour les activer, FreeLLMAPI enregistre une « clé » anonyme (POST keys sans `key`) ;
 * pour les couper, on supprime cette clé anonyme. Une vraie clé ajoutée en plus n'est jamais touchée.
 */
function KeylessGroup({
  providers,
  keys,
  engines,
  onChanged,
}: {
  providers: Provider[]
  keys: ProviderKey[]
  engines: SearchEngine[] | null
  onChanged: () => void
}) {
  const [busy, setBusy] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  const activeSearch = engines ? new Set(engines.map((e) => e.provider)) : null
  const list = providers
    .filter((p) => p.keyless)
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, 'fr') : a.kind === 'chat' ? -1 : 1))
  if (list.length === 0) return null

  const anonKeys = (platform: string) => keys.filter((k) => k.platform === platform && k.keyless)
  const inactive = (p: Provider) => p.kind === 'search' && activeSearch !== null && !activeSearch.has(p.platform)
  const toActivate = keylessToActivate(list, keys).filter((p) => !inactive(p))

  const mark = (platform: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(platform)
      else next.delete(platform)
      return next
    })

  async function toggle(p: Provider, on: boolean) {
    setError(null)
    mark(p.platform, true)
    try {
      if (on) await addKey({ platform: p.platform, key: '' })
      else for (const k of anonKeys(p.platform)) await deleteKey(k.id)
      onChanged()
    } catch (e) {
      setError(`${p.name} : ${e instanceof ApiError ? e.message : on ? 'activation impossible.' : 'impossible de le retirer.'}`)
    } finally {
      mark(p.platform, false)
    }
  }

  async function activateAll() {
    setError(null)
    const errors = await activateKeyless(toActivate, mark)
    if (errors.length > 0) setError(errors.join(' · '))
    onChanged()
  }

  return (
    <Group
      title="Sans clé"
      description="Ces services marchent sans compte, en accès anonyme. C’est gratuit, mais les limites sont plus serrées : idéal en renfort de tes clés."
      action={
        toActivate.length > 0 && (
          <Button variant="outline" size="sm" onClick={() => void activateAll()} disabled={busy.size > 0}>
            <Plus aria-hidden />
            Tout activer
          </Button>
        )
      }
    >
      {error && (
        <Notice tone="error" icon={CircleAlert}>
          {error}
        </Notice>
      )}
      {list.map((p) => {
        const anon = anonKeys(p.platform)
        const on = anon.length > 0
        const hasOwnKey = keys.some((k) => k.platform === p.platform && !k.keyless)
        const status = on ? (STATUS[anon[0].status] ?? { label: anon[0].status }) : null
        const notes = [
          p.kind === 'search' && 'Recherche web',
          SLOW_PLATFORMS.test(p.platform) && 'Très lent : peut rallonger les réponses en mode auto',
          inactive(p) && 'Pas de moteur actif chez FreeLLMAPI : il ne servirait pas',
          hasOwnKey && 'Ta clé est aussi utilisée',
          on && anon[0].lastHealthError && anon[0].status !== 'healthy' && anon[0].lastHealthError,
        ].filter(Boolean)
        return (
          <Row
            key={p.platform}
            label={
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {status && <Badge className={status.className}>{status.label}</Badge>}
                {on && !anon[0].enabled && <Badge>Désactivé</Badge>}
              </span>
            }
            description={notes.length > 0 ? notes.join(' · ') : undefined}
            control={
              <span className="flex items-center gap-2">
                {busy.has(p.platform) && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />}
                <Switch
                  checked={on}
                  disabled={busy.has(p.platform) || (!on && inactive(p))}
                  onCheckedChange={(checked) => void toggle(p, checked)}
                  aria-label={`${on ? 'Désactiver' : 'Activer'} ${p.name} sans clé`}
                />
              </span>
            }
          />
        )
      })}
    </Group>
  )
}

// --- Formulaire d'ajout ---------------------------------------------------------------

interface ProviderGroup {
  value: string
  items: Provider[]
}

/** Recherche web : quels moteurs peuvent servir maintenant (ceux qui ont une clé utilisable). */
function SearchSummary({ engines }: { engines: SearchEngine[] }) {
  const ready = engines.filter((e) => e.available)
  return (
    <p className={cn('flex items-start gap-1.5 pt-3 text-xs', ready.length ? 'text-muted-foreground' : 'text-destructive')}>
      <Globe className="mt-px size-3.5 shrink-0" aria-hidden />
      {ready.length
        ? `Recherche web : ${ready.map((e) => e.name).join(', ')}.${ready.length === 1 ? ' Ajoute un 2e moteur pour prendre le relais quand il atteint sa limite.' : ''}`
        : 'Aucun moteur de recherche utilisable : la recherche web du chat ne marchera pas. Ajoute une clé du groupe « Recherche web ».'}
    </p>
  )
}

function AddKeyForm({
  providers,
  engines,
  onAdded,
}: {
  providers: Provider[]
  /** Moteurs de recherche actifs (null = inconnu). */
  engines: SearchEngine[] | null
  onAdded: () => void
}) {
  const [provider, setProvider] = useState<Provider | null>(null)
  const [key, setKey] = useState('')
  const [label, setLabel] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  // Fournisseurs de chat d'abord (ceux qui servent au chat), puis ceux de recherche web.
  const groups: ProviderGroup[] = [
    { value: 'Modèles de chat', items: providers.filter((p) => p.kind === 'chat') },
    { value: 'Recherche web', items: providers.filter((p) => p.kind === 'search') },
  ].filter((g) => g.items.length > 0)

  // Fournisseur de recherche sans moteur actif chez FreeLLMAPI : sa clé serait enregistrée mais jamais utilisée.
  const activeSearch = engines ? new Set(engines.map((e) => e.provider)) : null
  const searchInactive = (p: Provider) => p.kind === 'search' && activeSearch !== null && !activeSearch.has(p.platform)
  const keyRequired = provider ? !provider.keyless : true
  const canSubmit = provider !== null && (!keyRequired || key.trim() !== '') && status.kind !== 'busy'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!provider || !canSubmit) return
    setStatus({ kind: 'busy' })
    try {
      const result = await addKey({ platform: provider.platform, key: key.trim(), ...(label.trim() && { label: label.trim() }) })
      setKey('')
      setLabel('')
      setShowKey(false)
      onAdded()
      setStatus(
        provider.kind === 'search'
          ? result.notice || searchInactive(provider)
            ? { kind: 'warning', text: `Clé ${provider.name} enregistrée, mais FreeLLMAPI n’a pas de moteur ${provider.name} actif : elle ne servira pas pour l’instant.` }
            : { kind: 'ok', text: `Clé ${provider.name} ajoutée (${result.maskedKey}) : la recherche web du chat peut maintenant l’utiliser.` }
          : result.notice
          ? { kind: 'warning', text: result.notice }
          : {
              kind: 'ok',
              text: `Clé ${provider.name} ajoutée (${result.maskedKey}). FreeLLMAPI la vérifie en arrière-plan${
                result.modelsAvailable ? ` : ${result.modelsAvailable} modèle${result.modelsAvailable > 1 ? 's' : ''} disponible${result.modelsAvailable > 1 ? 's' : ''}` : ''
              }.`,
            },
      )
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof ApiError ? err.message : 'Ajout impossible.' })
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <Group
        title="Ajouter une clé"
        description="Crée une clé gratuite chez un fournisseur (Groq, Google AI Studio, OpenRouter…) ou chez un moteur de recherche web (Tavily, Exa…), puis colle-la ici."
      >
        <Row
          label="Fournisseur"
          control={
            <Combobox<Provider>
              items={groups}
              value={provider}
              onValueChange={(p) => {
                setProvider(p)
                setStatus({ kind: 'idle' })
              }}
              itemToStringLabel={(p) => p.name}
              isItemEqualToValue={(a, b) => a.platform === b.platform}
              filter={(p, q) => `${p.name} ${p.platform}`.toLowerCase().includes(q.trim().toLowerCase())}
              autoHighlight
            >
              <ComboboxTrigger
                render={<Button variant="outline" className="h-9 w-56 justify-between gap-2 px-3 font-normal" aria-label="Choisir un fournisseur" />}
              >
                <span className={cn('truncate', !provider && 'text-muted-foreground')}>{provider?.name ?? 'Choisir…'}</span>
              </ComboboxTrigger>
              <ComboboxContent align="end" className="w-[min(20rem,calc(100vw-2rem))]">
                <ComboboxInput showTrigger={false} placeholder="Rechercher un fournisseur…" />
                <ComboboxEmpty>{providers.length ? 'Aucun fournisseur trouvé.' : 'Chargement…'}</ComboboxEmpty>
                <ComboboxList className="max-h-[min(22rem,calc(var(--available-height)-3rem))]">
                  {(group: ProviderGroup) => (
                    <ComboboxGroup key={group.value} items={group.items}>
                      <ComboboxLabel>{group.value}</ComboboxLabel>
                      <ComboboxCollection>
                        {(p: Provider) => (
                          <ComboboxItem key={p.platform} value={p}>
                            <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                              <span className="truncate">{p.name}</span>
                              {searchInactive(p) ? (
                                <span className="shrink-0 text-xs text-muted-foreground">inactif</span>
                              ) : p.keyCount > 0 ? (
                                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                                  <KeyRound className="size-3" aria-hidden />
                                  {p.keyCount}
                                </span>
                              ) : (
                                p.keyless && <span className="shrink-0 text-xs text-muted-foreground">sans clé</span>
                              )}
                            </span>
                          </ComboboxItem>
                        )}
                      </ComboboxCollection>
                    </ComboboxGroup>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          }
        />
        <Row
          label="Clé"
          description={
            provider?.keyless
              ? `${provider.name} marche aussi sans clé : laisse vide pour l’activer en accès anonyme.`
              : 'Elle part directement vers FreeLLMAPI, le chat ne la garde pas.'
          }
        >
          <div className="flex gap-2">
            <Input
              type={showKey ? 'text' : 'password'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={provider?.keyless ? 'Facultative' : 'Colle la clé du fournisseur'}
              autoComplete="off"
              spellCheck={false}
              aria-label="Clé du fournisseur"
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
        </Row>
        <Row
          label="Nom"
          description="Facultatif, pour t’y retrouver si tu as plusieurs clés (ex. « perso »)."
          control={<Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={64} aria-label="Nom de la clé" className="h-9 w-56" />}
        />
      </Group>

      {provider && searchInactive(provider) && status.kind === 'idle' && (
        <Notice tone="warning" icon={Info}>
          FreeLLMAPI n’a pas de moteur {provider.name} actif pour l’instant (absent de son catalogue, ou éteint dans son dashboard,
          page Modèles › Search). Une clé ajoutée ici serait enregistrée mais pas utilisée : préfère un autre moteur.
        </Notice>
      )}
      {status.kind === 'ok' && (
        <Notice tone="success" icon={CircleCheck}>
          {status.text}
        </Notice>
      )}
      {status.kind === 'warning' && (
        <Notice tone="warning" icon={Info}>
          {status.text}
        </Notice>
      )}
      {status.kind === 'error' && (
        <Notice tone="error" icon={CircleAlert}>
          {status.text}
        </Notice>
      )}

      <div className="mb-8 flex justify-end">
        <Button type="submit" disabled={!canSubmit} className="h-9 min-w-32 px-4">
          {status.kind === 'busy' ? (
            <LoaderCircle className="animate-spin" aria-label="Ajout en cours" />
          ) : (
            <>
              <Plus aria-hidden />
              Ajouter la clé
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
