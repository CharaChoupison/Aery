import { IS_TAURI } from './transport'

/**
 * Version web construite (serveur Aery, ou npm run preview) : enregistre le service worker qui garde
 * l'interface sur l'appareil, pour qu'elle s'ouvre même sans Tailscale. Ni en dev, ni dans l'appli.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || IS_TAURI || !('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e: unknown) => console.warn('[aery] Service worker refusé :', e))
  })
}
