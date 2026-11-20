import { CircleAlert } from 'lucide-react'
import { useMemo } from 'react'
import { RefreshButton } from '@/components/page'
import { Group, Notice, Row, UsageBar } from '@/components/settings/layout'
import { useAdminData } from '@/hooks/useAdminData'
import {
  formatCompact,
  formatNumber,
  getChain,
  getKeys,
  getProviders,
  getQuotaForecast,
  getRateLimitUsage,
  getTokenUsage,
  type RateLimitRow,
  type UsageWindow,
} from '@/lib/admin'

/** « 1er décembre », « 15 décembre » */
function frenchDate(d: Date): string {
  const month = d.toLocaleDateString('fr-FR', { month: 'long' })
  return `${d.getDate() === 1 ? '1er' : d.getDate()} ${month}`
}

const percent = (used: number, max: number) => `${Math.round((used / max) * 100)} %`

const WINDOWS: { key: 'rpd' | 'rpm' | 'tpm'; label: string; unit: string }[] = [
  { key: 'rpd', label: 'Requêtes aujourd’hui', unit: 'requêtes' },
  { key: 'rpm', label: 'Requêtes cette minute', unit: 'requêtes' },
  { key: 'tpm', label: 'Tokens cette minute', unit: 'tokens' },
]

/** Pression d'un modèle = sa limite la plus entamée (0 → 1). */
function pressure(row: RateLimitRow): number {
  return Math.max(0, ...WINDOWS.map(({ key }) => (row[key] ? row[key]!.used / row[key]!.limit : 0)))
}

/**
 * Où j'en suis dans mes quotas : consommation du mois par fournisseur, budgets de tokens,
 * et limites par minute / par jour des modèles déjà sollicités.
 */
export function UsagePage() {
  const keys = useAdminData((s) => getKeys(s), [])
  const providers = useAdminData((s) => getProviders(s), [])
  const tokens = useAdminData((s) => getTokenUsage(s), [])
  const limits = useAdminData((s) => getRateLimitUsage(s), [])
  const quotas = useAdminData((s) => getQuotaForecast(s), [])
  const chain = useAdminData((s) => getChain(s), [])

  const reload = () => [keys, providers, tokens, limits, quotas, chain].forEach((d) => d.reload())
  const loading = keys.loading || tokens.loading || limits.loading
  const error = keys.error ?? tokens.error ?? limits.error

  const providerName = useMemo(() => new Map((providers.data ?? []).map((p) => [p.platform, p.name])), [providers.data])
  const modelName = useMemo(() => new Map((chain.data ?? []).map((m) => [m.modelDbId, m.displayName])), [chain.data])

  // Consommation du mois, regroupée par fournisseur (une ligne même s'il y a plusieurs clés).
  const byProvider = useMemo(() => {
    const map = new Map<string, { platform: string; requests: number; tokens: number; requestCap: number; tokenCap: number }>()
    for (const k of keys.data ?? []) {
      const row = map.get(k.platform) ?? { platform: k.platform, requests: 0, tokens: 0, requestCap: 0, tokenCap: 0 }
      row.requests += k.monthlyUsage.requests
      row.tokens += k.monthlyUsage.tokens
      row.requestCap += k.monthlyRequestCap ?? 0
      row.tokenCap += k.monthlyTokenCap ?? 0
      map.set(k.platform, row)
    }
    return [...map.values()].filter((r) => r.requests > 0 || r.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  }, [keys.data])

  const totalRequests = byProvider.reduce((n, r) => n + r.requests, 0)
  const totalTokens = byProvider.reduce((n, r) => n + r.tokens, 0)
  const resetsAt = keys.data?.[0]?.monthlyUsage.resetsAt
  const resetLabel = resetsAt ? frenchDate(new Date(resetsAt)) : null

  const busyModels = (limits.data?.rows ?? []).filter((r) => WINDOWS.some(({ key }) => (r[key]?.used ?? 0) > 0)).sort((a, b) => pressure(b) - pressure(a))
  const budgetModels = (tokens.data?.models ?? []).filter((m) => m.budget > 0 && m.used > 0).sort((a, b) => b.used / b.budget - a.used / a.budget)
  const pools = (quotas.data?.pools ?? []).filter((p) => p.remainingPct != null && p.limit)

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Les fournisseurs gratuits limitent le nombre de requêtes et de tokens (par minute, par jour ou par mois). Quand un
          quota est épuisé, FreeLLMAPI passe au modèle suivant.
        </p>
        <RefreshButton loading={loading} onClick={reload} />
      </div>

      {error && (
        <Notice tone="error" icon={CircleAlert}>
          {error}
        </Notice>
      )}

      <Group title="Ce mois-ci" description={resetLabel ? `Remise à zéro le ${resetLabel}.` : undefined}>
        {keys.data && (
          <div className="grid grid-cols-2 gap-3 py-3">
            <BigNumber label="Requêtes" value={formatNumber(totalRequests)} />
            <BigNumber label="Tokens" value={formatCompact(totalTokens)} title={formatNumber(totalTokens)} />
          </div>
        )}
        {tokens.data && tokens.data.totalBudget > 0 && (
          <Row
            label="Budget mensuel de tokens"
            description={`${formatCompact(tokens.data.totalUsed)} sur ${formatCompact(tokens.data.totalBudget)} (${percent(tokens.data.totalUsed, tokens.data.totalBudget)})`}
          >
            <UsageBar value={tokens.data.totalUsed} max={tokens.data.totalBudget} label="Budget mensuel de tokens" />
          </Row>
        )}
        {byProvider.map((r) => {
          const cap = r.tokenCap || r.requestCap
          const used = r.tokenCap ? r.tokens : r.requests
          return (
            <Row
              key={r.platform}
              label={providerName.get(r.platform) ?? r.platform}
              description={
                cap
                  ? `${formatCompact(used)} sur ${formatCompact(cap)} ${r.tokenCap ? 'tokens' : 'requêtes'} (plafond que tu as fixé)`
                  : `${formatNumber(r.requests)} requête${r.requests > 1 ? 's' : ''} · ${formatCompact(r.tokens)} tokens · ${totalTokens ? percent(r.tokens, totalTokens) : '0 %'} du total`
              }
            >
              {cap ? (
                <UsageBar value={used} max={cap} label={`Plafond ${providerName.get(r.platform) ?? r.platform}`} />
              ) : (
                <UsageBar share value={r.tokens} max={Math.max(totalTokens, 1)} label={`Part de ${providerName.get(r.platform) ?? r.platform}`} />
              )}
            </Row>
          )
        })}
        {keys.data && byProvider.length === 0 && <p className="py-3 text-sm text-muted-foreground">Aucune requête ce mois-ci.</p>}
      </Group>

      {budgetModels.length > 0 && (
        <Group title="Budgets mensuels par modèle">
          {budgetModels.slice(0, 10).map((m) => (
            <Row key={m.modelDbId} label={m.displayName} description={`${formatCompact(m.used)} sur ${formatCompact(m.budget)} tokens (${percent(m.used, m.budget)})`}>
              <UsageBar value={m.used} max={m.budget} label={m.displayName} />
            </Row>
          ))}
        </Group>
      )}

      <Group title="Limites en cours" description="Les modèles déjà sollicités dans les dernières 24 h, du plus entamé au moins entamé.">
        {limits.data && busyModels.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">Aucune limite entamée pour l’instant : tout est disponible.</p>
        )}
        {busyModels.slice(0, 12).map((r) => (
          <Row key={r.modelDbId} label={modelName.get(r.modelDbId) ?? r.modelId} description={providerName.get(r.platform) ?? r.platform}>
            <div className="grid gap-2 sm:grid-cols-3">
              {WINDOWS.map(({ key, label, unit }) => r[key] && <LimitBar key={key} label={label} unit={unit} window={r[key]!} />)}
            </div>
          </Row>
        ))}
      </Group>

      {pools.length > 0 && (
        <Group title="Quotas annoncés par les fournisseurs" description="Solde restant renvoyé directement par certains fournisseurs.">
          {pools.map((p) => (
            <Row
              key={p.pool}
              label={providerName.get(p.platform) ?? p.platform}
              description={`${formatNumber(p.remaining ?? 0)} restant${(p.remaining ?? 0) > 1 ? 's' : ''} sur ${formatNumber(p.limit ?? 0)}${
                p.resetAt ? ` · remise à zéro ${new Date(p.resetAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : ''
              }`}
            >
              <UsageBar value={(p.limit ?? 0) - (p.remaining ?? 0)} max={p.limit ?? 1} label={`Quota ${p.platform}`} />
            </Row>
          ))}
        </Group>
      )}
    </>
  )
}

function BigNumber({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-xl border p-3" title={title}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function LimitBar({ label, unit, window: w }: { label: string; unit: string; window: UsageWindow }) {
  return (
    <div>
      <p className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums" title={`${formatNumber(w.used)} ${unit} sur ${formatNumber(w.limit)}`}>
          {formatCompact(w.used)} / {formatCompact(w.limit)}
        </span>
      </p>
      <UsageBar value={w.used} max={w.limit} label={label} />
    </div>
  )
}
