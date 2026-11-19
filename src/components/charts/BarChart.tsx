import { useRef, useState } from 'react'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

export interface Series {
  label: string
  /** Variable CSS de la couleur, ex. « var(--viz-1) ». */
  color: string
}

export interface Bucket {
  key: string
  /** Libellé court sous l'axe (« 19 nov. »). */
  label: string
  /** Libellé complet dans l'infobulle (« mardi 19 novembre »). */
  title: string
  /** Une valeur par série, dans le même ordre que `series`. */
  values: number[]
}

interface Props {
  series: Series[]
  buckets: Bucket[]
  format: (n: number) => string
  height?: number
  className?: string
}

/** Graduations « rondes » : 0, 10, 20, 30… plutôt que 0, 13, 26, 39. */
function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 4, step: 1 }
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough
  return { top: step * Math.ceil(max / step), step }
}

/**
 * Histogramme empilé, fait en HTML/CSS (pas de bibliothèque de graphiques).
 *  - une colonne par période ; chaque série est un segment, séparés de 2 px ;
 *  - survol / focus clavier d'une colonne → infobulle avec les valeurs ;
 *  - les barres « poussent » depuis l'axe à l'affichage (GSAP).
 */
export function BarChart({ series, buckets, format, height = 200, className }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const motion = useMotion()
  const [active, setActive] = useState<number | null>(null)

  const totals = buckets.map((b) => b.values.reduce((a, v) => a + v, 0))
  const { top, step } = niceMax(Math.max(0, ...totals))
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step)
  // Au plus ~8 libellés sous l'axe, pour qu'ils ne se chevauchent pas.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / 8))

  useGSAP(
    () => {
      if (!motion) return
      gsap.from('[data-bar]', { scaleY: 0, transformOrigin: '50% 100%', duration: 0.6, stagger: 0.015, ease: 'power3.out' })
    },
    { scope: rootRef, dependencies: [buckets.map((b) => b.key + b.values.join()).join('|')], revertOnUpdate: true },
  )

  return (
    // gap-5 : la graduation du haut (centrée sur sa ligne) ne touche pas la légende.
    <div ref={rootRef} className={cn('flex flex-col gap-5', className)}>
      {/* Légende : la couleur n'est jamais le seul repère (nom écrit à côté). */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: s.color }} aria-hidden />
            {s.label}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        {/* Axe vertical */}
        <div className="relative w-10 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums" style={{ height }}>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2" style={{ bottom: `${(t / top) * 100}%` }}>
              {format(t)}
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height }} onMouseLeave={() => setActive(null)}>
            {/* Lignes de grille, discrètes */}
            {ticks.map((t) => (
              <div
                key={t}
                className={cn('absolute inset-x-0 border-t', t === 0 ? 'border-border' : 'border-dashed border-border/60')}
                style={{ bottom: `${(t / top) * 100}%` }}
                aria-hidden
              />
            ))}

            <div className="absolute inset-0 flex items-end">
              {buckets.map((b, i) => (
                <div
                  key={b.key}
                  tabIndex={0}
                  role="img"
                  aria-label={`${b.title} : ${series.map((s, j) => `${s.label} ${format(b.values[j])}`).join(', ')}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  // Zone de survol = toute la hauteur de la colonne (plus facile à viser que la barre).
                  className={cn(
                    'relative flex h-full flex-1 items-end justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    active === i && 'bg-muted/60',
                  )}
                >
                  <div data-bar className="flex w-[min(28px,70%)] flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]">
                    {series.map((s, j) =>
                      b.values[j] > 0 ? (
                        <div key={s.label} style={{ height: (b.values[j] / top) * height, background: s.color }} />
                      ) : null,
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Infobulle */}
            {active !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
                style={{ left: `clamp(4.5rem, ${((active + 0.5) / buckets.length) * 100}%, calc(100% - 4.5rem))` }}
              >
                <p className="mb-1 font-medium">{buckets[active].title}</p>
                {series.map((s, j) => (
                  <p key={s.label} className="flex items-center justify-between gap-4">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-2 rounded-sm" style={{ background: s.color }} aria-hidden />
                      {s.label}
                    </span>
                    <span className="font-medium tabular-nums">{format(buckets[active].values[j])}</span>
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Axe horizontal */}
          <div className="mt-1.5 flex text-[11px] text-muted-foreground">
            {buckets.map((b, i) => (
              <span key={b.key} className="flex-1 truncate text-center">
                {i % labelEvery === 0 ? b.label : ''}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
