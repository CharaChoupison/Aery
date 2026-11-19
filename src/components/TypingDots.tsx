import { useRef } from 'react'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** Trois points qui sautillent pendant que le modèle prépare sa réponse. */
export function TypingDots({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const motion = useMotion()

  useGSAP(
    () => {
      if (!motion) return
      // yoyo + repeat: -1 → monte, redescend, à l'infini. stagger décale chaque point.
      gsap.to('[data-dot]', {
        y: -5,
        opacity: 1,
        duration: 0.35,
        ease: 'sine.inOut',
        stagger: { each: 0.12, repeat: -1, yoyo: true },
      })
    },
    { scope: ref, dependencies: [motion], revertOnUpdate: true },
  )

  return (
    <span ref={ref} role="status" aria-label="Réponse en cours" className={cn('flex h-5 items-center gap-1', className)}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          data-dot
          className={cn('size-1.5 rounded-full bg-muted-foreground opacity-50', !motion && 'animate-pulse')}
        />
      ))}
    </span>
  )
}
