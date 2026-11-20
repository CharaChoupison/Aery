import { CircleAlert, CircleCheck, Eye, EyeOff, Info, KeyRound, LoaderCircle, Plus, Trash2 } from 'lucide-react'
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
import { useAdminData } from '@/hooks/useAdminData'
import { addKey, deleteKey, formatCompact, formatNumber, getKeys, getProviders, type Provider, type ProviderKey } from '@/lib/admin'
import { ApiError } from '@/lib/api'
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
 * Clés des fournisseurs (Groq, Google, OpenRouter…) enregistrées dans FreeLLMAPI.
 * La clé tapée part directement vers FreeLLMAPI (via notre proxy) : le chat ne la garde nulle part,
 * et FreeLLMAPI ne la renvoie jamais en clair (seulement masquée : « gsk_…ab12 »).
 */
export function KeysPage({ onChanged }: { onChanged: () => void }) {
  const providers = useAdminData((s) => getProviders(s), [])
  const keys = useAdminData((s) => getKeys(s), [])
  const [pendingDelete, setPendingDelete] = useState<ProviderKey | null>(null)
  const [deleteStatus, setDeleteStatus] = useState<Status>({ kind: 'idle' })

  const names = useMemo(() => new Map((providers.data ?? []).map((p) => [p.platform, p.name])), [providers.data])
  const reload = () => {
    providers.reload()
    keys.reload()
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
      <AddKeyForm providers={providers.data ?? []} onAdded={() => (reload(), onChanged())} />

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
            + {keylessCount} fournisseur{keylessCount > 1 ? 's' : ''} utilisé{keylessCount > 1 ? 's' : ''} sans clé (accès anonyme).
          </p>
        )}
      </Group>

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

// --- Formulaire d'ajout ---------------------------------------------------------------

interface ProviderGroup {
  value: string
  items: Provider[]
}

function AddKeyForm({ providers, onAdded }: { providers: Provider[]; onAdded: () => void }) {
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
        result.notice
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
      <Group title="Ajouter une clé" description="Crée une clé gratuite chez un fournisseur (Groq, Google AI Studio, OpenRouter…) puis colle-la ici.">
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
                              {p.keyCount > 0 ? (
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
