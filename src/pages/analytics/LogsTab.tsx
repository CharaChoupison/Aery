import { Bug, CircleX, Info, Search, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ErrorNotice } from '@/components/page'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAdminData } from '@/hooks/useAdminData'
import { getLogs, type LogLevel } from '@/lib/admin'
import { cn } from '@/lib/utils'

const LEVELS: { value: LogLevel; label: string; icon: typeof Info; className: string }[] = [
  { value: 'error', label: 'Erreurs', icon: CircleX, className: 'text-destructive' },
  { value: 'warn', label: 'Avertissements', icon: TriangleAlert, className: 'text-amber-700 dark:text-amber-400' },
  { value: 'info', label: 'Infos', icon: Info, className: 'text-muted-foreground' },
  { value: 'debug', label: 'Debug', icon: Bug, className: 'text-muted-foreground' },
]
const LEVEL_STYLE = Object.fromEntries(LEVELS.map((l) => [l.value, l])) as Record<string, (typeof LEVELS)[number]>

const LIVE_INTERVAL = 4000 // ms

/** Journaux du serveur FreeLLMAPI : filtres par niveau, recherche, et mode « en direct ». */
export function LogsTab() {
  const [levels, setLevels] = useState<LogLevel[]>(['error', 'warn', 'info'])
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [live, setLive] = useState(false)

  // On attend que la frappe se calme (300 ms) avant de lancer la recherche.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const logs = useAdminData((signal) => getLogs({ levels, q: debounced, limit: 300 }, signal), [levels, debounced])
  const { reload } = logs

  // Mode « en direct » : on recharge toutes les 4 s.
  useEffect(() => {
    if (!live) return
    const t = setInterval(reload, LIVE_INTERVAL)
    return () => clearInterval(t)
  }, [live, reload])

  const counts = logs.data?.counts ?? {}
  const entries = [...(logs.data?.entries ?? [])].reverse() // le plus récent en haut

  function toggleLevel(level: LogLevel) {
    setLevels((prev) => (prev.includes(level) ? prev.filter((l) => l !== level) : [...prev, level]))
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        {LEVELS.map((l) => {
          const on = levels.includes(l.value)
          return (
            <button
              key={l.value}
              type="button"
              aria-pressed={on}
              onClick={() => toggleLevel(l.value)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                on ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <l.icon className="size-3.5" aria-hidden />
              {l.label}
              <span className="tabular-nums opacity-70">{counts[l.value] ?? 0}</span>
            </button>
          )
        })}
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher dans les journaux"
            aria-label="Rechercher dans les journaux"
            className="h-8 pl-9"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <Switch checked={live} onCheckedChange={setLive} />
          En direct
          {live && <span className="size-2 animate-pulse rounded-full bg-[var(--viz-good)]" aria-hidden />}
        </label>
      </div>

      {logs.error && <ErrorNotice message={logs.error} onRetry={reload} />}

      <div className="max-h-[65vh] overflow-y-auto rounded-2xl border bg-card font-mono text-xs" aria-live={live ? 'polite' : 'off'}>
        {logs.data && entries.length === 0 && (
          <p className="py-10 text-center font-sans text-sm text-muted-foreground">Aucune ligne ne correspond.</p>
        )}
        <ul>
          {entries.map((e) => {
            const style = LEVEL_STYLE[e.level] ?? LEVEL_STYLE.debug
            return (
              <li key={e.id} className="flex gap-3 border-b px-3 py-1.5 last:border-0 hover:bg-muted/40">
                <time dateTime={e.ts} className="shrink-0 text-muted-foreground tabular-nums">
                  {new Date(e.ts).toLocaleTimeString('fr-FR')}
                </time>
                <span className={cn('flex w-14 shrink-0 items-center gap-1 font-medium uppercase', style.className)}>
                  <style.icon className="size-3" aria-hidden />
                  {e.level}
                </span>
                <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
                  {[e.provider, e.model].filter(Boolean).length > 0 && (
                    <span className="mr-2 text-muted-foreground">[{[e.provider, e.model].filter(Boolean).join(' / ')}]</span>
                  )}
                  {e.message}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
