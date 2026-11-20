import { CircleAlert, Gauge, X } from 'lucide-react'
import { Appear } from '@/components/Appear'
import { UsageBar } from '@/components/settings/layout'
import { useAdminData } from '@/hooks/useAdminData'
import { formatCompact, formatMs, formatNumber, getChain, getRateLimitUsage, getSummary, type RateLimitRow } from '@/lib/admin'

/** Limite du jour la plus entamée d'un modèle (0 → 1). */
const dayPressure = (r: RateLimitRow) => (r.rpd && r.rpd.limit > 0 ? r.rpd.used / r.rpd.limit : 0)

/**
 * /usage : petite carte au-dessus du champ de saisie avec la conso des dernières 24 h.
 * Rien n'est ajouté à la conversation (ni envoyé au modèle). Le détail est dans Paramètres › Utilisation.
 */
export function UsageCard({ onClose, onOpenDetails }: { onClose: () => void; onOpenDetails: () => void }) {
  const summary = useAdminData((s) => getSummary('24h', s), [])
  const limits = useAdminData((s) => getRateLimitUsage(s), [])
  const chain = useAdminData((s) => getChain(s), [])
  const names = new Map((chain.data ?? []).map((m) => [m.modelDbId, m.displayName]))
  const busiest = (limits.data?.rows ?? [])
    .filter((r) => r.rpd && r.rpd.used > 0)
    .sort((a, b) => dayPressure(b) - dayPressure(a))
    .slice(0, 3)
  const s = summary.data
  const error = summary.error ?? limits.error

  return (
    <Appear from={{ autoAlpha: 0, y: 8, duration: 0.25 }} role="status" aria-label="Utilisation des dernières 24 heures" className="rounded-2xl border bg-background p-4 shadow-sm">
      <div className="mb-3 flex items-center gap-2">
        <Gauge className="size-4 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">Dernières 24 h</p>
        <button
          type="button"
          onClick={onOpenDetails}
          className="ml-auto rounded-md px-1.5 text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Voir le détail
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          title="Fermer"
          className="flex size-6 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>

      {error && !s ? (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Requêtes" value={s ? formatNumber(s.totalRequests) : null} />
            <Stat label="Réussite" value={s ? `${Math.round(s.successRate)} %` : null} />
            <Stat label="Tokens" value={s ? formatCompact(s.totalInputTokens + s.totalOutputTokens) : null} />
            <Stat label="Latence moyenne" value={s ? formatMs(s.avgLatencyMs) : null} />
          </dl>
          {busiest.length > 0 && (
            <div className="mt-3 flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">Limites du jour les plus entamées</p>
              {busiest.map((r) => (
                <div key={r.modelDbId}>
                  <p className="mb-1 flex justify-between gap-2 text-xs">
                    <span className="truncate">{names.get(r.modelDbId) ?? r.modelId}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatCompact(r.rpd!.used)} / {formatCompact(r.rpd!.limit)}
                    </span>
                  </p>
                  <UsageBar value={r.rpd!.used} max={r.rpd!.limit} label={`Requêtes du jour, ${names.get(r.modelDbId) ?? r.modelId}`} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Appear>
  )
}

function Stat({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-lg font-semibold tabular-nums">{value ?? <span className="inline-block h-5 w-10 animate-pulse rounded bg-muted" />}</dd>
    </div>
  )
}
