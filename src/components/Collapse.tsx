import { useRef, useState, type ReactNode } from 'react'
import { gsap, useGSAP, useMotion } from '@/lib/motion'

type Props = {
  open: boolean
  children: ReactNode
  className?: string
}

/**
 * Bloc qui se déplie / se replie en douceur (hauteur 0 ↔ auto + fondu).
 *
 * Astuce : à la fermeture, on garde le contenu affiché le temps de l'animation
 * (`rendered`), puis on le retire vraiment. Sinon il disparaîtrait d'un coup.
 * À l'ouverture, les éléments `[data-conv-item]` arrivent en petite cascade.
 */
export function Collapse({ open, children, className }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const motion = useMotion()
  const [rendered, setRendered] = useState(open)
  // Ouverture : on affiche tout de suite (synchronisé pendant le rendu, pas dans un effet).
  if (open && !rendered) setRendered(true)
  // Pas d'animation au premier affichage, seulement quand `open` change.
  const prevOpen = useRef(open)

  useGSAP(
    () => {
      if (prevOpen.current === open) return
      prevOpen.current = open
      const el = ref.current
      if (!el) return
      // Re-clic pendant l'animation : on repart de la hauteur actuelle au lieu de sauter.
      const midway = gsap.isTweening(el)
      gsap.killTweensOf([el, ...el.querySelectorAll('[data-conv-item]')])

      if (!motion) {
        if (!open) setRendered(false)
        return
      }

      if (open) {
        if (!midway) gsap.set(el, { height: 0, autoAlpha: 0, overflow: 'hidden' })
        gsap.to(el, { height: 'auto', autoAlpha: 1, duration: 0.28, ease: 'power2.out', clearProps: 'height,opacity,visibility,overflow' })
        const items = el.querySelectorAll('[data-conv-item]')
        if (!midway && items.length > 0) {
          gsap.from(items, {
            autoAlpha: 0,
            x: -8,
            duration: 0.3,
            // Cascade rapide : 0,15 s au total maximum, même pour un gros projet.
            stagger: Math.min(0.03, 0.15 / items.length),
            clearProps: 'opacity,visibility,transform',
          })
        }
      } else {
        gsap.to(el, {
          height: 0,
          autoAlpha: 0,
          overflow: 'hidden',
          duration: 0.2,
          ease: 'power2.inOut',
          onComplete: () => setRendered(false),
        })
      }
    },
    { dependencies: [open], scope: ref },
  )

  if (!rendered) return null
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
