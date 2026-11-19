import { Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'
import { useRef } from 'react'
import { IconButton } from '@/components/IconButton'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { usePreferences, type ThemePreference } from '@/lib/preferences'
import { switchTheme } from '@/lib/theme'

const THEMES: { value: ThemePreference; label: string; icon: LucideIcon }[] = [
  { value: 'system', label: 'Système', icon: Monitor },
  { value: 'light', label: 'Clair', icon: Sun },
  { value: 'dark', label: 'Sombre', icon: Moon },
]

/** Centre de l'élément cliqué : point de départ du cercle de la transition. */
function centerOf(el: Element) {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
}

/** Petit bouton qui fait tourner les thèmes : Système → Clair → Sombre. */
export function ThemeToggle() {
  const { theme } = usePreferences()
  const motion = useMotion()
  const iconRef = useRef<HTMLSpanElement>(null)

  const index = THEMES.findIndex((t) => t.value === theme)
  const current = THEMES[index]
  const next = THEMES[(index + 1) % THEMES.length]
  const Icon = current.icon

  // À chaque changement de thème, l'icône arrive en tournant.
  useGSAP(
    () => {
      if (!motion || !iconRef.current) return
      gsap.from(iconRef.current, { rotate: -120, scale: 0.4, autoAlpha: 0, duration: 0.5, ease: 'back.out(2)' })
    },
    { dependencies: [theme] },
  )

  return (
    <IconButton
      label={`Thème : ${current.label}. Passer en ${next.label.toLowerCase()}`}
      side="top"
      onClick={(e) => switchTheme(next.value, { animate: motion, origin: centerOf(e.currentTarget) })}
    >
      <span ref={iconRef} className="flex">
        <Icon className="size-4" aria-hidden />
      </span>
    </IconButton>
  )
}
