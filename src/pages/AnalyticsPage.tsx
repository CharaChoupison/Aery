import {
  Activity,
  ArrowDown,
  ArrowUp,
  ChartColumn,
  CircleCheck,
  Clock,
  Coins,
  Gauge,
  Layers,
  ScrollText,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { AnimatedNumber } from '@/components/AnimatedNumber'
import { Appear } from '@/components/Appear'
import { BarChart, type Bucket } from '@/components/charts/BarChart'
import { Card, ErrorNotice, PageHeader, RefreshButton, Segmented } from '@/components/page'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAdminData } from '@/hooks/useAdminData'
import {
  formatCompact,
  formatMs,
  formatNumber,
  getByModel,
  getErrorDistribution,
  getSummary,
  getTimeline,
  RANGES,
  type Range,
  type TimelinePoint,
} from '@/lib/admin'
import { LogsTab } from '@/pages/analytics/LogsTab'
import { RequestsTab } from '@/pages/analytics/RequestsTab'

type Tab = 'overview' | 'requests' | 'logs'

export function AnalyticsPage() {
  const [range, setRange] = useState<Range>('7d')
  const [tab, setTab] = useState<Tab>('overview')
  const [refreshKey, setRefreshKey] = useState(0) // bouton Actualiser : remonte l'onglet ouvert

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <PageHeader title="Analytique" description="Volume de requêtes, latence, consommation de tokens, échecs et journaux de FreeLLMAPI.">
        {tab !== 'logs' && <Segmented label="Période" value={range} onChange={setRange} options={RANGES} />}
        <RefreshButton loading={false} onClick={() => setRefreshKey((k) => k + 1)} />
      </PageHeader>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-5">
        <TabsList>
          <TabsTrigger value="overview" className="px-3">
            <ChartColumn aria-hidden />
            Vue d’ensemble
          </TabsTrigger>
          <TabsTrigger value="requests" className="px-3">
            <Layers aria-hidden />
            Requêtes
          </TabsTrigger>
          <TabsTrigger value="logs" className="px-3">
            <ScrollText aria-hidden />
            Journaux
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <Overview key={refreshKey} range={range} />
        </TabsContent>
        <TabsContent value="requests">
          <RequestsTab key={refreshKey} range={range} />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab key={refreshKey} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// --- Vue d'ensemble -------------------------------------------------------------------

function Overview({ range }: { range: Range }) {
  const summary = useAdminData((s) => getSummary(range, s), [range])
  const timeline = useAdminData((s) => getTimeline(range, s), [range])
  const byModel = useAdminData((s) => getByModel(range, s), [range])
  const errors = useAdminData((s) => getErrorDistribution(range, s), [range])

  const error = summary.error ?? timeline.error
  const s = summary.data
  const requestBuckets = timeline.data ? buildBuckets(range, timeline.data, (p) => [p.successCount, p.failureCount]) : null
  const tokenBuckets = timeline.data ? buildBuckets(range, timeline.data, (p) => [p.inputTokens, p.outputTokens]) : null

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNotice message={error} onRetry={() => (summary.reload(), timeline.reload())} />}

      {s && (
        <Appear stagger={0.04} className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Requêtes" icon={Activity} value={s.totalRequests} format={(n) => formatNumber(Math.round(n))} />
          <Stat
            label="Taux de réussite"
            icon={CircleCheck}
            value={s.successRate}
            format={(n) => `${n.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`}
          />
          <Stat label="Tokens en entrée" icon={ArrowDown} value={s.totalInputTokens} format={(n) => formatCompact(Math.round(n))} />
          <Stat label="Tokens en sortie" icon={ArrowUp} value={s.totalOutputTokens} format={(n) => formatCompact(Math.round(n))} />
          <Stat label="Latence moy." icon={Gauge} value={s.avgLatencyMs} format={formatMs} />
          <Stat label="Latence P95" icon={Clock} value={s.p95LatencyMs} format={formatMs} />
          <Stat label="1er token moy." icon={Zap} value={s.avgTtfbMs} format={formatMs} hint="Temps avant le premier mot (TTFT)" />
          <Stat
            label="Économies est."
            icon={Coins}
            value={s.estimatedCostSavings}
            format={(n) => n.toLocaleString('fr-FR', { style: 'currency', currency: 'USD' })}
            hint="Ce que ces requêtes auraient coûté chez un fournisseur payant"
          />
        </Appear>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Requêtes au fil du temps" icon={ChartColumn}>
          {requestBuckets ? (
            <BarChart
              buckets={requestBuckets}
              series={[
                { label: 'Réussies', color: 'var(--viz-1)' },
                { label: 'Échecs', color: 'var(--viz-critical)' },
              ]}
              format={(n) => formatNumber(n)}
            />
          ) : (
            <ChartSkeleton />
          )}
        </Card>
        <Card title="Tokens au fil du temps" icon={Coins}>
          {tokenBuckets ? (
            <BarChart
              buckets={tokenBuckets}
              series={[
                { label: 'Entrée', color: 'var(--viz-1)' },
                { label: 'Sortie', color: 'var(--viz-2)' },
              ]}
              format={formatCompact}
            />
          ) : (
            <ChartSkeleton />
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card title="Par modèle" icon={Layers} className="min-w-0">
          {byModel.data?.length === 0 && <Empty />}
          {byModel.data && byModel.data.length > 0 && (
            <div className="-mx-4 -my-4 overflow-x-auto">
              <table className="w-full min-w-[32rem] text-sm">
                <thead className="border-b text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="py-2.5 pl-4 font-medium">Modèle</th>
                    <th scope="col" className="py-2.5 pr-4 text-right font-medium">Requêtes</th>
                    <th scope="col" className="py-2.5 pr-4 text-right font-medium">Réussite</th>
                    <th scope="col" className="py-2.5 pr-4 text-right font-medium">Latence moy.</th>
                    <th scope="col" className="py-2.5 pr-4 text-right font-medium">Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {byModel.data.slice(0, 10).map((m) => (
                    <tr key={`${m.platform}/${m.modelId}`} className="border-b last:border-0">
                      <td className="max-w-64 py-2.5 pl-4">
                        <p className="truncate font-medium" title={m.modelId}>
                          {m.displayName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">{m.platform}</p>
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{formatNumber(m.requests)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{m.successRate.toLocaleString('fr-FR')} %</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{formatMs(m.avgLatencyMs)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{formatCompact(m.totalInputTokens + m.totalOutputTokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Échecs par type" icon={TriangleAlert}>
          {errors.data && errors.data.byCategory.length === 0 && <Empty text="Aucun échec sur la période." />}
          {errors.data && errors.data.byCategory.length > 0 && <ErrorBars rows={errors.data.byCategory} />}
        </Card>
      </div>
    </div>
  )
}

function Stat({
  label,
  icon: Icon,
  value,
  format,
  hint,
}: {
  label: string
  icon: LucideIcon
  value: number | null
  format: (n: number) => string
  hint?: string
}) {
  return (
    <div className="rounded-2xl border bg-card p-4" title={hint}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-3.5 text-muted-foreground" aria-hidden />
        </span>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {value == null ? '–' : <AnimatedNumber value={value} format={format} />}
      </p>
    </div>
  )
}

/** Une barre horizontale par type d'erreur (une seule série : pas besoin de légende). */
function ErrorBars({ rows }: { rows: { category: string; count: number }[] }) {
  const max = Math.max(...rows.map((r) => r.count))
  return (
    <Appear stagger={0.05} className="flex flex-col gap-3">
      {rows.map((r) => (
        <div key={r.category}>
          <div className="mb-1 flex justify-between gap-2 text-sm">
            <span className="truncate">{translateCategory(r.category)}</span>
            <span className="font-medium tabular-nums">{r.count}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(r.count / max) * 100}%`, background: 'var(--viz-critical)' }} />
          </div>
        </div>
      ))}
    </Appear>
  )
}

const CATEGORY_LABELS: Record<string, string> = {
  'Rate Limited (429)': 'Limite de débit (429)',
  'Auth Error (401)': 'Authentification (401)',
  'Forbidden (403)': 'Refusé (403)',
  'Not Found (404)': 'Introuvable (404)',
  'Timeout/Connection': 'Délai / connexion',
  'Server Error (500)': 'Erreur serveur (500)',
  'Unavailable (503)': 'Indisponible (503)',
  Other: 'Autre',
}
const translateCategory = (c: string) => CATEGORY_LABELS[c] ?? c

function Empty({ text = 'Pas encore de données sur la période.' }: { text?: string }) {
  return <p className="py-6 text-center text-sm text-muted-foreground">{text}</p>
}

function ChartSkeleton() {
  return <div className="h-[236px] animate-pulse rounded-xl bg-muted/50" />
}

// --- Découpage du temps pour les graphiques -------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hourKey = (d: Date) => `${dayKey(d)}T${pad(d.getHours())}:00:00`

const RANGE_DAYS: Partial<Record<Range, number>> = { '7d': 7, '30d': 30, '90d': 90 }

/**
 * FreeLLMAPI ne renvoie que les jours (ou heures) où il s'est passé quelque chose.
 * On complète avec des zéros pour avoir un axe du temps régulier.
 */
function buildBuckets(range: Range, points: TimelinePoint[], pick: (p: TimelinePoint) => number[]): Bucket[] {
  const byKey = new Map(points.map((p) => [p.timestamp, p]))
  const empty = pick({ timestamp: '', requests: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0 })
  const now = new Date()

  if (range === '24h') {
    return Array.from({ length: 24 }, (_, i) => {
      const d = new Date(now)
      d.setHours(now.getHours() - 23 + i, 0, 0, 0)
      const key = hourKey(d)
      const p = byKey.get(key)
      const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
      return { key, label: `${d.getHours()} h`, title: `${day}, ${d.getHours()} h – ${d.getHours() + 1} h`, values: p ? pick(p) : empty }
    })
  }

  // Par jour : de « il y a N jours » (ou la 1re donnée si plus ancienne) jusqu'à aujourd'hui.
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((RANGE_DAYS[range] ?? 7) - 1))
  const first = points[0]?.timestamp
  if (first) {
    const [y, m, d] = first.slice(0, 10).split('-').map(Number)
    const firstDate = new Date(y, m - 1, d)
    if (firstDate < start) start.setTime(firstDate.getTime())
  }
  const days = Math.round((now.getTime() - start.getTime()) / 86_400_000) + 1
  // « Depuis le début » sur une très longue période : seulement les jours avec des données.
  if (days > 180) {
    return points.map((p) => {
      const [y, m, d] = p.timestamp.slice(0, 10).split('-').map(Number)
      const date = new Date(y, m - 1, d)
      return { key: p.timestamp, label: date.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }), title: date.toLocaleDateString('fr-FR', { dateStyle: 'full' }), values: pick(p) }
    })
  }
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    const key = dayKey(d)
    const p = byKey.get(key)
    return {
      key,
      label: d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }),
      title: d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }),
      values: p ? pick(p) : empty,
    }
  })
}
