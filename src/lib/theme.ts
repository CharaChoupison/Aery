import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { getPreferences, setPreferences, type ThemePreference } from './preferences'
import { IS_TAURI } from './transport'

/**
 * Mode sombre.
 * Tailwind/shadcn passent en sombre quand <html> a la classe « dark » (voir index.css).
 * En mode « system », on suit le réglage de macOS via la media query prefers-color-scheme,
 * et on réagit en direct quand il change (ex. bascule automatique le soir).
 */

const darkQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null

function resolve(pref: ThemePreference): 'light' | 'dark' {
  if (pref === 'system') return darkQuery?.matches ? 'dark' : 'light'
  return pref
}

export function applyTheme(pref: ThemePreference): void {
  const dark = resolve(pref) === 'dark'
  document.documentElement.classList.toggle('dark', dark)
  // color-scheme : barres de défilement, champs natifs… dans la bonne couleur.
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'

  // Appli Tauri : la barre de titre de la fenêtre suit aussi (null = suivre macOS).
  if (IS_TAURI) {
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(pref === 'system' ? null : pref))
      .catch(() => {
        // pas grave : seule la barre de titre garde la couleur du système
      })
  }
}

/** Applique le thème choisi et suit les changements du système tant qu'on est en mode « system ». */
export function useTheme(pref: ThemePreference): void {
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system' || !darkQuery) return
    const onChange = () => applyTheme('system')
    darkQuery.addEventListener('change', onChange)
    return () => darkQuery.removeEventListener('change', onChange)
  }, [pref])
}

type DocumentWithTransitions = Document & {
  startViewTransition?: (update: () => void) => { ready: Promise<void> }
}

/**
 * Change de thème depuis un clic. Avec les animations, le nouveau thème se dévoile en cercle
 * à partir du point cliqué, grâce à l'API View Transitions du navigateur :
 * il prend une « photo » de la page avant, applique le changement, puis anime entre les deux.
 */
export function switchTheme(next: ThemePreference, options: { animate: boolean; origin?: { x: number; y: number } }) {
  const update = () => {
    // flushSync : React met l'interface à jour TOUT DE SUITE (la « photo d'après » doit être à jour).
    flushSync(() => setPreferences({ theme: next }))
    applyTheme(next)
  }

  const doc = document as DocumentWithTransitions
  if (!options.animate || !doc.startViewTransition) {
    update()
    return
  }

  const { x, y } = options.origin ?? { x: window.innerWidth / 2, y: window.innerHeight / 2 }
  // Rayon du cercle : distance jusqu'au coin le plus éloigné, pour couvrir tout l'écran.
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))

  doc
    .startViewTransition(update)
    .ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 550, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' },
      )
    })
    .catch(() => {
      // transition annulée (ex. double clic rapide) : le thème est appliqué quand même
    })
}

/** Appelé une fois avant le premier rendu (main.tsx) : pas de flash blanc au démarrage en mode sombre. */
export function applyInitialTheme(): void {
  applyTheme(getPreferences().theme)
}
