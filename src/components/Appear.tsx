import { useRef, type ComponentProps } from 'react'
import { gsap, useGSAP, useMotion } from '@/lib/motion'

type Props = ComponentProps<'div'> & {
  /** État de départ de l'animation (l'élément « arrive » depuis ces valeurs). */
  from?: gsap.TweenVars
  /** false : pas d'animation (ex. messages déjà là quand on ouvre la conversation). */
  enabled?: boolean
  /** Si défini, on anime les enfants directs un par un, décalés de N secondes (effet cascade). */
  stagger?: number
}

const DEFAULT_FROM: gsap.TweenVars = { autoAlpha: 0, y: 12 }

/**
 * Un <div> qui apparaît en douceur quand il est affiché pour la première fois.
 * gsap.from() : on part des valeurs « from » et on revient à l'état normal de l'élément.
 * clearProps : à la fin, on retire les styles ajoutés par GSAP (l'élément redevient « normal »).
 */
export function Appear({ from = DEFAULT_FROM, enabled = true, stagger, children, ...props }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const motion = useMotion()

  // Sans tableau de dépendances, useGSAP ne s'exécute qu'une fois, à l'apparition.
  useGSAP(() => {
    const el = ref.current
    if (!el || !motion || !enabled) return
    gsap.from(stagger === undefined ? el : el.children, { ...from, stagger, clearProps: 'all' })
  })

  return (
    <div ref={ref} {...props}>
      {children}
    </div>
  )
}
