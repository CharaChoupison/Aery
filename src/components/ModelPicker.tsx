import { CircleAlert, LoaderCircle, RefreshCw, Sparkles } from 'lucide-react'
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
import { isRouterModel, type ModelInfo } from '@/lib/api'

interface Props {
  value: string
  onChange: (modelId: string) => void
  models: ModelInfo[]
  loading: boolean
  error: string | null
  onOpen: () => void
  onRefresh: () => void
}

interface Group {
  value: string // titre du groupe
  items: ModelInfo[]
}

/** 131072 → « 128k », 1048576 → « 1M » */
function formatContext(tokens: number | null): string | null {
  if (!tokens) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1024)}k`
}

/** Le routeur en premier, puis une famille par groupe (ordre alphabétique), « Autres » à la fin. */
function groupModels(models: ModelInfo[]): Group[] {
  const router = models.filter((m) => isRouterModel(m.id))
  const byFamily = new Map<string, ModelInfo[]>()
  for (const m of models) {
    if (isRouterModel(m.id)) continue
    byFamily.set(m.family, [...(byFamily.get(m.family) ?? []), m])
  }
  const families = [...byFamily.keys()].sort((a, b) =>
    a === 'Autres' ? 1 : b === 'Autres' ? -1 : a.localeCompare(b),
  )
  return [
    ...(router.length ? [{ value: router[0].family, items: router }] : []),
    ...families.map((f) => ({ value: f, items: byFamily.get(f)!.sort((a, b) => a.name.localeCompare(b.name)) })),
  ]
}

/** Nom affiché dans la liste. La recherche porte sur CE texte, pour qu'on trouve ce qu'on voit. */
function displayName(model: ModelInfo): string {
  return model.id === 'auto' ? 'Auto (le routeur choisit)' : model.name
}

/** Recherche sur le nom affiché, le nom d'origine, l'identifiant et la famille (« llama », « qwen »…). */
function matches(model: ModelInfo, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [displayName(model), model.name, model.id, model.family].some((s) => s.toLowerCase().includes(q))
}

export function ModelPicker({ value, onChange, models, loading, error, onOpen, onRefresh }: Props) {
  // Le modèle choisi peut ne plus être disponible (quota épuisé, clé retirée) : on le garde affiché.
  const current: ModelInfo = models.find((m) => m.id === value) ?? {
    id: value,
    name: value === 'auto' ? 'Auto' : value,
    family: 'Indisponible',
    contextWindow: null,
  }
  const unavailable = models.length > 0 && !models.some((m) => m.id === value)

  const list = groupModels(models)
  const groups = unavailable ? [{ value: 'Indisponible actuellement', items: [current] }, ...list] : list

  const label = value === 'auto' ? 'Auto' : current.name

  return (
    <Combobox<ModelInfo>
      items={groups}
      value={current}
      onValueChange={(m) => m && onChange(m.id)}
      onOpenChange={(open) => open && onOpen()}
      itemToStringLabel={displayName}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(m, query) => matches(m, query)}
      autoHighlight
    >
      <ComboboxTrigger
        render={
          <Button
            variant="ghost"
            className="h-8 max-w-[60vw] gap-1.5 px-2 font-medium sm:max-w-xs"
            aria-label={`Modèle : ${label}. Changer de modèle`}
            title={value}
          />
        }
      >
        {unavailable && <CircleAlert className="size-4 text-destructive" aria-hidden />}
        {isRouterModel(value) && !unavailable && <Sparkles className="size-4 text-muted-foreground" aria-hidden />}
        <span className="truncate">{label}</span>
      </ComboboxTrigger>

      <ComboboxContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
        <div className="flex items-center gap-1 pr-1">
          <ComboboxInput showTrigger={false} placeholder="Rechercher un modèle…" className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            aria-label="Recharger la liste des modèles"
            title="Recharger la liste"
            className="mt-1"
          >
            {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          </Button>
        </div>

        {error && (
          <p className="mx-2 mt-2 flex gap-1.5 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            {error}
          </p>
        )}

        <ComboboxEmpty>{loading ? 'Chargement…' : 'Aucun modèle trouvé.'}</ComboboxEmpty>

        <ComboboxList className="max-h-[min(26rem,calc(var(--available-height)-3rem))]">
          {(group: Group) => (
            <ComboboxGroup key={group.value} items={group.items}>
              <ComboboxLabel>{group.value}</ComboboxLabel>
              <ComboboxCollection>
                {(m: ModelInfo) => (
                  <ComboboxItem key={m.id} value={m} className="items-start">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{displayName(m)}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[m.id, formatContext(m.contextWindow)].filter(Boolean).join(' · ')}
                        {m.id === 'fusion' && ' · consomme plusieurs requêtes'}
                      </span>
                    </span>
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
