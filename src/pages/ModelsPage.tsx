import { Eye, KeyRound, Route, Search, Wrench } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Appear } from '@/components/Appear'
import { Badge, Card, ErrorNotice, PageHeader, RefreshButton, Segmented } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAdminData } from '@/hooks/useAdminData'
import { formatContext, getChain, getRouting, STRATEGY_LABELS, type ChainModel, type ModelScore } from '@/lib/admin'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

type ContextFilter = 'all' | '32k' | '128k' | '1m'
const CONTEXT_MIN: Record<ContextFilter, number> = { all: 0, '32k': 32_000, '128k': 128_000, '1m': 1_000_000 }

// Les trois axes du routeur : une couleur par colonne, rappelée par un point dans l'en-tête.
const AXES = [
  { key: 'reliability', label: 'Fiabilité', color: 'var(--viz-3)' },
  { key: 'speed', label: 'Vitesse', color: 'var(--viz-1)' },
  { key: 'intelligence', label: 'Intelligence', color: 'var(--viz-7)' },
] as const

type Member = ChainModel & { scores: ModelScore | null }

/** Une ligne du tableau = un modèle, éventuellement servi par plusieurs fournisseurs. */
interface Row {
  key: string
  label: string
  rank: number
  members: Member[]
  best: Member // le fournisseur le mieux noté : c'est lui qu'on affiche
  enabled: boolean
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
}

const PAGE_SIZE = 60 // lignes affichées d'un coup (le catalogue complet en compte des centaines)

/**
 * Comme le dashboard de FreeLLMAPI :
 *  1. on ne garde que les modèles dont le fournisseur a une clé (sauf si « tout le catalogue ») ;
 *  2. on regroupe un même modèle servi par plusieurs fournisseurs ;
 *  3. on trie par meilleur score.
 */
function buildRows(models: ChainModel[], scores: ModelScore[], withoutKey: boolean): Row[] {
  const scoreById = new Map(scores.map((s) => [s.modelDbId, s]))
  const groups = new Map<string, Member[]>()
  for (const m of models) {
    if (!withoutKey && m.keyCount === 0) continue
    const key = m.groupKey ?? `solo:${m.modelDbId}`
    groups.set(key, [...(groups.get(key) ?? []), { ...m, scores: scoreById.get(m.modelDbId) ?? null }])
  }
  const value = (m: Member) => m.scores?.score ?? -1
  return [...groups.entries()]
    .map(([key, members]) => {
      members.sort((a, b) => value(b) - value(a))
      return {
        key,
        label: members[0].groupLabel ?? cleanName(members[0].displayName),
        rank: 0,
        members,
        best: members[0],
        enabled: members.some((m) => m.enabled),
        contextWindow: Math.max(0, ...members.map((m) => m.contextWindow ?? 0)) || null,
        supportsVision: members.some((m) => m.supportsVision),
        supportsTools: members.some((m) => m.supportsTools),
      }
    })
    .sort((a, b) => value(b.best) - value(a.best))
    .map((row, i) => ({ ...row, rank: i + 1 }))
}

/** « Nemotron 3 Ultra 550B (Kilo) » → « Nemotron 3 Ultra 550B » : le fournisseur est affiché à part. */
function cleanName(name: string): string {
  return name.replace(/\s*\([^)]*\)\s*$/, '')
}

function limitLabel(m: ChainModel): string | null {
  if (m.rpdLimit) return `${m.rpdLimit}/j`
  if (m.rpmLimit) return `${m.rpmLimit}/min`
  return null
}

const percent = (n: number) => `${Math.round(n * 100)} %`

export function ModelsPage() {
  const chain = useAdminData((signal) => getChain(signal), [])
  const routing = useAdminData((signal) => getRouting(signal), [])
  const [query, setQuery] = useState('')
  const [vision, setVision] = useState(false)
  const [tools, setTools] = useState(false)
  const [context, setContext] = useState<ContextFilter>('all')
  const [withoutKey, setWithoutKey] = useState(false)
  const [shown, setShown] = useState(PAGE_SIZE)

  // On fusionne : la liste des modèles (limites, contexte…) + les scores du routeur.
  const rows = useMemo(
    () => buildRows(chain.data ?? [], routing.data?.scores ?? [], withoutKey),
    [chain.data, routing.data, withoutKey],
  )

  const q = query.trim().toLowerCase()
  const visible = rows.filter(
    (r) =>
      (!q || [r.label, ...r.members.flatMap((m) => [m.displayName, m.modelId, m.platform])].some((s) => s.toLowerCase().includes(q))) &&
      (!vision || r.supportsVision) &&
      (!tools || r.supportsTools) &&
      (r.contextWindow ?? 0) >= CONTEXT_MIN[context],
  )
  const enabledCount = visible.filter((r) => r.enabled).length

  const error = chain.error ?? routing.error
  const loading = chain.loading || routing.loading
  const weights = routing.data?.weights

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader
        title="Modèles"
        description="Les modèles de ta chaîne de repli FreeLLMAPI, classés par le routeur selon un score qui combine fiabilité, vitesse et intelligence, mesurées sur le trafic réel."
      >
        <RefreshButton
          loading={loading}
          onClick={() => {
            chain.reload()
            routing.reload()
          }}
        />
      </PageHeader>

      {error && <ErrorNotice message={error} onRetry={() => (chain.reload(), routing.reload())} />}

      {routing.data && weights && (
        <Appear>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex size-9 items-center justify-center rounded-xl bg-muted">
                  <Route className="size-4" aria-hidden />
                </span>
                <div>
                  <p className="text-xs text-muted-foreground">Stratégie de routage</p>
                  <p className="font-medium">{STRATEGY_LABELS[routing.data.strategy] ?? routing.data.strategy}</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground">
                fiabilité {percent(weights.reliability)} · vitesse {percent(weights.speed)} · intelligence{' '}
                {percent(weights.intelligence)}
              </p>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Lecture seule : pour changer de stratégie ou activer un modèle, passe par le dashboard de FreeLLMAPI.
            </p>
          </Card>
        </Appear>
      )}

      {/* Filtres, sur une seule ligne au-dessus du tableau */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un modèle ou un fournisseur"
            aria-label="Rechercher un modèle ou un fournisseur"
            className="h-9 pl-9"
          />
        </div>
        <FilterToggle pressed={vision} onChange={setVision} icon={Eye} label="Vision" />
        <FilterToggle pressed={tools} onChange={setTools} icon={Wrench} label="Outils" />
        <Segmented
          label="Fenêtre de contexte minimale"
          value={context}
          onChange={setContext}
          options={[
            { value: 'all', label: 'Tout contexte' },
            { value: '32k', label: '32K+' },
            { value: '128k', label: '128K+' },
            { value: '1m', label: '1M+' },
          ]}
        />
      </div>

      <div className="-mt-2 flex flex-wrap items-center justify-between gap-3">
        {chain.data && (
          <p className="text-sm text-muted-foreground">
            {enabledCount} des {visible.length} modèle{visible.length > 1 ? 's' : ''} affiché{visible.length > 1 ? 's' : ''} sont actifs
            dans la chaîne
          </p>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={withoutKey} onCheckedChange={setWithoutKey} />
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          Inclure les fournisseurs sans clé
        </label>
      </div>

      <ModelsTable rows={visible.slice(0, shown)} />
      {visible.length > shown && (
        <Button variant="outline" className="self-center" onClick={() => setShown((n) => n + PAGE_SIZE)}>
          Afficher plus ({visible.length - shown} restants)
        </Button>
      )}
    </div>
  )
}

function FilterToggle({
  pressed,
  onChange,
  icon: Icon,
  label,
}: {
  pressed: boolean
  onChange: (v: boolean) => void
  icon: typeof Eye
  label: string
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={cn(
        'flex h-9 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        pressed ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  )
}

function ModelsTable({ rows }: { rows: Row[] }) {
  const ref = useRef<HTMLTableSectionElement>(null)
  const motion = useMotion()
  const signature = rows.map((r) => r.key).join(',')

  // Les lignes arrivent en cascade, puis les barres de score se remplissent.
  useGSAP(
    () => {
      if (!motion || !rows.length) return
      const tl = gsap.timeline()
      // stagger.amount : la cascade dure 0,4 s au total, qu'il y ait 10 lignes ou 60.
      tl.from('tr', { autoAlpha: 0, y: 8, stagger: { amount: 0.4 }, duration: 0.3, clearProps: 'all' })
      tl.from('[data-score-bar]', { scaleX: 0, transformOrigin: '0% 50%', duration: 0.6, stagger: { amount: 0.4 } }, 0.1)
    },
    { scope: ref, dependencies: [signature], revertOnUpdate: true },
  )

  return (
    <div className="overflow-x-auto rounded-2xl border bg-card">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="border-b text-left text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="w-10 py-3 pl-4 font-medium">
              #
            </th>
            <th scope="col" className="py-3 pr-4 font-medium">
              Modèle
            </th>
            {AXES.map((a) => (
              <th key={a.key} scope="col" className="w-36 py-3 pr-4 font-medium">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: a.color }} aria-hidden />
                  {a.label}
                </span>
              </th>
            ))}
            <th scope="col" className="w-16 py-3 pr-4 text-right font-medium">
              Score
            </th>
            <th scope="col" className="w-24 py-3 pr-4 text-right font-medium">
              Statut
            </th>
          </tr>
        </thead>
        <tbody ref={ref}>
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="py-10 text-center text-muted-foreground">
                Aucun modèle ne correspond.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const m = r.best
            const ctx = formatContext(r.contextWindow)
            const limit = limitLabel(m)
            const providers = [...new Set(r.members.map((x) => x.platform))]
            return (
              <tr key={r.key} className={cn('border-b last:border-0 hover:bg-muted/40', !r.enabled && 'opacity-60')}>
                <td className="py-3 pl-4 text-muted-foreground tabular-nums">{r.rank}</td>
                <td className="py-3 pr-4">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium" title={r.members.map((x) => `${x.platform} : ${x.modelId}`).join('\n')}>
                      {r.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{providers.join(', ')}</span>
                    {limit && <Badge>{limit}</Badge>}
                    {ctx && <Badge>{ctx} ctx</Badge>}
                    {r.supportsVision && (
                      <Badge>
                        <Eye className="size-3" aria-hidden />
                        Vision
                      </Badge>
                    )}
                    {r.supportsTools && (
                      <Badge>
                        <Wrench className="size-3" aria-hidden />
                        Outils
                      </Badge>
                    )}
                  </div>
                </td>
                {AXES.map((a) => (
                  <td key={a.key} className="py-3 pr-4">
                    {m.scores ? <ScoreBar value={m.scores[a.key]} color={a.color} /> : <span className="text-muted-foreground">–</span>}
                  </td>
                ))}
                <td className="py-3 pr-4 text-right font-mono tabular-nums">{m.scores ? m.scores.score.toFixed(3) : '–'}</td>
                <td className="py-3 pr-4 text-right">
                  <StatusBadge row={r} />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ScoreBar({ value, color }: { value: number; color: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100)
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div data-score-bar className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="w-7 text-right text-xs text-muted-foreground tabular-nums">{pct}</span>
    </div>
  )
}

function StatusBadge({ row }: { row: Row }) {
  if (row.members.every((m) => m.retiredUpstream)) return <Badge>Retiré</Badge>
  if (row.members.every((m) => m.keyCount === 0)) return <Badge>Sans clé</Badge>
  if (!row.enabled) return <Badge>Inactif</Badge>
  return (
    <Badge className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      Actif
    </Badge>
  )
}
