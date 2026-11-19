import { Ban, ChevronRight, CircleCheck, CircleX, LoaderCircle } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Appear } from '@/components/Appear'
import { ErrorNotice, Segmented } from '@/components/page'
import { Button } from '@/components/ui/button'
import { useAdminData } from '@/hooks/useAdminData'
import { formatMs, formatNumber, getRequestDetail, getRequests, type Range, type RequestStatus } from '@/lib/admin'
import { cn } from '@/lib/utils'

const PAGE = 50

type StatusFilter = 'all' | RequestStatus

/** Statut = icône + texte (jamais la couleur seule). */
const STATUS: Record<RequestStatus, { label: string; icon: typeof CircleCheck; className: string }> = {
  success: { label: 'Réussie', icon: CircleCheck, className: 'text-emerald-700 dark:text-emerald-400' },
  error: { label: 'Échec', icon: CircleX, className: 'text-destructive' },
  canceled: { label: 'Annulée', icon: Ban, className: 'text-muted-foreground' },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function RequestsTab({ range }: { range: Range }) {
  const [status, setStatus] = useState<StatusFilter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [openId, setOpenId] = useState<number | null>(null)

  const requests = useAdminData(
    (signal) => getRequests(range, { status: status === 'all' ? undefined : status, limit }, signal),
    [range, status, limit],
  )
  const rows = requests.data?.rows ?? []
  const total = requests.data?.total ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="Filtrer par statut"
          value={status}
          onChange={(v) => {
            setStatus(v)
            setLimit(PAGE)
          }}
          options={[
            { value: 'all', label: 'Toutes' },
            { value: 'success', label: 'Réussies' },
            { value: 'error', label: 'Échecs' },
            { value: 'canceled', label: 'Annulées' },
          ]}
        />
        {requests.data && (
          <p className="text-sm text-muted-foreground">
            {formatNumber(rows.length)} sur {formatNumber(total)} requête{total > 1 ? 's' : ''}
          </p>
        )}
      </div>

      {requests.error && <ErrorNotice message={requests.error} onRetry={requests.reload} />}

      <div className="overflow-x-auto rounded-2xl border bg-card">
        <table className="w-full min-w-[48rem] text-sm">
          <thead className="border-b text-left text-xs text-muted-foreground">
            <tr>
              <th scope="col" className="w-8 py-3 pl-3" aria-label="Détails" />
              <th scope="col" className="py-3 pr-4 font-medium">Date</th>
              <th scope="col" className="py-3 pr-4 font-medium">Modèle</th>
              <th scope="col" className="py-3 pr-4 font-medium">Statut</th>
              <th scope="col" className="py-3 pr-4 text-right font-medium">Tokens (entrée → sortie)</th>
              <th scope="col" className="py-3 pr-4 text-right font-medium">Latence</th>
            </tr>
          </thead>
          <tbody>
            {requests.data && rows.length === 0 && (
              <tr>
                <td colSpan={6} className="py-10 text-center text-muted-foreground">
                  Aucune requête sur la période.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const s = STATUS[r.status] ?? STATUS.error
              const open = openId === r.id
              return (
                <Fragment key={r.id}>
                  <tr
                    className={cn('cursor-pointer border-b hover:bg-muted/40', open && 'bg-muted/40')}
                    onClick={() => setOpenId(open ? null : r.id)}
                  >
                    <td className="py-2.5 pl-3">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-label={open ? 'Masquer les détails' : 'Afficher les détails'}
                        className="flex rounded p-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        <ChevronRight className={cn('size-4 text-muted-foreground transition-transform', open && 'rotate-90')} aria-hidden />
                      </button>
                    </td>
                    <td className="py-2.5 pr-4 whitespace-nowrap text-muted-foreground tabular-nums">{formatTime(r.createdAt)}</td>
                    <td className="max-w-72 py-2.5 pr-4">
                      <p className="truncate font-medium" title={r.modelId}>
                        {r.modelId}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.platform}
                        {r.attemptCount > 1 && ` · ${r.attemptCount} essais`}
                      </p>
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className={cn('flex items-center gap-1.5 font-medium', s.className)}>
                        <s.icon className="size-4" aria-hidden />
                        {s.label}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right whitespace-nowrap tabular-nums">
                      {formatNumber(r.inputTokens ?? 0)} → {formatNumber(r.outputTokens ?? 0)}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{formatMs(r.latencyMs)}</td>
                  </tr>
                  {open && (
                    <tr className="border-b bg-muted/20">
                      <td colSpan={6} className="px-4 py-3">
                        <RequestDetailPanel id={r.id} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {rows.length < total && (
        <Button variant="outline" className="self-center" onClick={() => setLimit((l) => l + PAGE)} disabled={requests.loading}>
          {requests.loading && <LoaderCircle className="animate-spin" aria-hidden />}
          Afficher plus
        </Button>
      )}
    </div>
  )
}

/** Détail d'une requête : chaque essai du routeur (repli d'un fournisseur à l'autre). */
function RequestDetailPanel({ id }: { id: number }) {
  const detail = useAdminData((signal) => getRequestDetail(id, signal), [id])
  if (detail.error) return <ErrorNotice message={detail.error} />
  const d = detail.data
  if (!d) return <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Chargement" />

  return (
    <Appear from={{ autoAlpha: 0, y: -4, duration: 0.25 }} className="flex flex-col gap-3 text-sm">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <Info label="Modèle demandé" value={d.requestedModel ?? 'auto'} />
        <Info label="Premier token" value={formatMs(d.ttfbMs)} />
        <Info label="Type" value={d.requestType} />
        <Info label="Client" value={d.clientAgent ?? '–'} />
      </dl>
      {d.error && <p className="rounded-lg bg-destructive/5 p-2 font-mono text-xs break-words text-destructive">{d.error}</p>}
      {d.attempts.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Essais du routeur</p>
          <ol className="flex flex-col gap-1">
            {d.attempts.map((a) => (
              <li key={a.ordinal} className="flex flex-wrap items-baseline gap-x-2 rounded-lg bg-background px-2.5 py-1.5">
                <span className="w-4 text-xs text-muted-foreground tabular-nums">{a.ordinal}.</span>
                <span className="font-medium">{a.modelId}</span>
                <span className="text-xs text-muted-foreground">{a.platform}</span>
                <span className={cn('text-xs font-medium', a.outcome === 'success' ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive')}>
                  {a.outcome === 'success' ? 'réussi' : a.outcome}
                </span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{formatMs(a.durationMs)}</span>
                {a.errorSummary && <p className="w-full pl-6 font-mono text-xs break-words text-muted-foreground">{a.errorSummary}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Appear>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate">{value}</dd>
    </div>
  )
}
