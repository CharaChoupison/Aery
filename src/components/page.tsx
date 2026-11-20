import { CircleAlert, LoaderCircle, RefreshCw, type LucideIcon } from 'lucide-react'
import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { IconButton } from '@/components/IconButton'
import { gsap, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** Titre + description d'une page, avec des actions à droite (période, rafraîchir…). */
export function PageHeader({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

export function Card({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title?: string
  icon?: LucideIcon
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-2xl border bg-card text-card-foreground', className)}>
      {title && (
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}
            {title}
          </h2>
          {action}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

/** Boutons « segmentés » (un seul choix possible), comme les périodes 24 h / 7 j / 30 j. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  size = 'default',
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (value: T) => void
  label: string
  size?: 'sm' | 'default'
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLSpanElement>(null)
  const placedRef = useRef(false)
  const motion = useMotion()

  // La pastille de fond glisse sous le bouton choisi (posée sans animation au premier affichage).
  useLayoutEffect(() => {
    const selected = groupRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (!selected || !pillRef.current) return
    const target = { x: selected.offsetLeft, width: selected.offsetWidth, autoAlpha: 1 }
    if (!placedRef.current || !motion) gsap.set(pillRef.current, target)
    else gsap.to(pillRef.current, { ...target, duration: 0.35, ease: 'power3.out' })
    placedRef.current = true
  }, [value, motion])

  return (
    <div ref={groupRef} role="radiogroup" aria-label={label} className="relative inline-flex rounded-xl border bg-muted/40 p-0.5">
      <span ref={pillRef} aria-hidden className="invisible absolute top-0.5 bottom-0.5 left-0 rounded-[10px] bg-primary shadow-sm" />
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            title={o.title}
            aria-label={o.title}
            onClick={() => onChange(o.value)}
            className={cn(
              'relative flex items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition-colors duration-300 outline-none',
              'focus-visible:ring-2 focus-visible:ring-ring/50',
              size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3 text-sm',
              selected ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span className="flex-1">{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="font-medium underline underline-offset-2">
          Réessayer
        </button>
      )}
    </div>
  )
}

export function RefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <IconButton label="Actualiser" variant="outline" onClick={onClick} disabled={loading}>
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
    </IconButton>
  )
}

/** Petite étiquette arrondie (« 128k ctx », « Vision »…). */
export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground', className)}>
      {children}
    </span>
  )
}
