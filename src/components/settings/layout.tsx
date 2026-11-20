import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Appear } from '@/components/Appear'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

// Briques de mise en page communes aux pages des Paramètres (lignes « libellé à gauche, contrôle à droite »).

export function Group({ title, description, action, children }: { title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-8 last:mb-0">
      <div className="mb-1 flex items-end justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  )
}

/** Une ligne : libellé + description à gauche, contrôle à droite, contenu optionnel en dessous. */
export function Row({
  label,
  description,
  control,
  children,
}: {
  label: ReactNode
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="border-b py-4 last:border-0">
      <div className="flex items-center justify-between gap-6">
        <div className="min-w-0">
          <div className="text-sm">{label}</div>
          {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  )
}

export function SelectControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  label: string
}) {
  return (
    <Select items={options} value={value} onValueChange={(v) => v && onChange(v as T)}>
      <SelectTrigger aria-label={label} className="min-w-36 border-transparent shadow-none hover:bg-muted">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end" alignItemWithTrigger={false}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

const NOTICE_TONES = {
  warning: 'bg-amber-500/10 text-amber-900 dark:text-amber-200',
  success: 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
  error: 'bg-destructive/10 text-destructive',
}

export function Notice({ tone, icon: Icon, children }: { tone: keyof typeof NOTICE_TONES; icon: LucideIcon; children: ReactNode }) {
  return (
    <Appear
      role={tone === 'error' ? 'alert' : 'status'}
      from={tone === 'error' ? { x: -8, ease: 'elastic.out(1, 0.35)', duration: 0.6 } : { autoAlpha: 0, y: -4 }}
      className={cn('my-3 flex gap-2 rounded-lg p-3 text-sm', NOTICE_TONES[tone])}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </Appear>
  )
}

/**
 * Barre de progression. Pour un quota : orange à partir de 80 %, rouge à 100 %.
 * share = simple part d'un total (pas une limite) : toujours bleue.
 */
export function UsageBar({ value, max, label, share = false }: { value: number; max: number; label: string; share?: boolean }) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0
  const color = share ? 'var(--viz-1)' : ratio >= 1 ? 'var(--viz-critical)' : ratio >= 0.8 ? 'var(--viz-warning)' : 'var(--viz-1)'
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(value, max)}
      className="h-2 overflow-hidden rounded-full bg-muted"
    >
      <div data-usage-bar className="h-full rounded-full transition-[width]" style={{ width: `${Math.max(ratio * 100, value > 0 ? 1.5 : 0)}%`, background: color }} />
    </div>
  )
}
