import { useRef } from 'react'
import { gsap, useGSAP, useMotion } from '@/lib/motion'

interface Props {
  value: number
  format: (n: number) => string
  className?: string
}

/**
 * Un nombre qui « compte » jusqu'à sa valeur (39 → on voit défiler 0, 5, 12… 39).
 * GSAP anime un simple objet { v } et on écrit le texte à chaque image.
 * Quand la valeur change (autre période), il repart de l'ancienne valeur.
 */
export function AnimatedNumber({ value, format, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null)
  const current = useRef({ v: 0 })
  const motion = useMotion()

  useGSAP(
    () => {
      const el = ref.current
      if (!el) return
      if (!motion) {
        current.current.v = value
        el.textContent = format(value)
        return
      }
      el.textContent = format(current.current.v) // repart de l'ancienne valeur, sans flash
      gsap.to(current.current, {
        v: value,
        duration: 0.9,
        ease: 'power2.out',
        onUpdate: () => {
          el.textContent = format(current.current.v)
        },
      })
    },
    { dependencies: [value, motion] },
  )

  // Texte initial = valeur finale : correct même sans JavaScript d'animation (lecteurs d'écran).
  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  )
}
