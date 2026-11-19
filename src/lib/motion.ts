import { useGSAP } from '@gsap/react'
import gsap from 'gsap'
import { useSyncExternalStore } from 'react'
import { usePreferences } from './preferences'

/**
 * Animations avec GSAP.
 *
 * useGSAP (de @gsap/react) remplace useEffect pour les animations : il « range » tout seul
 * les animations quand le composant disparaît (sinon elles continueraient sur un élément mort).
 *
 * Accessibilité : par défaut (« Système »), si « Réduire les animations » est activé
 * dans macOS, on n'anime rien.
 */
gsap.registerPlugin(useGSAP)

// Valeurs communes : mêmes courbes partout = une interface qui paraît cohérente.
gsap.defaults({ ease: 'power3.out', duration: 0.4 })

export { gsap, useGSAP }

const reducedQuery = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null

function subscribeReduced(callback: () => void): () => void {
  reducedQuery?.addEventListener('change', callback)
  return () => reducedQuery?.removeEventListener('change', callback)
}

/**
 * true si on a le droit d'animer.
 *  - « Système » : on anime, sauf si « Réduire les animations » est activé dans macOS ;
 *  - « Activées » / « Désactivées » : choix forcé dans l'appli.
 */
export function useMotion(): boolean {
  const { motion } = usePreferences()
  const reduced = useSyncExternalStore(subscribeReduced, () => reducedQuery?.matches ?? false)
  return motion === 'on' || (motion === 'system' && !reduced)
}
