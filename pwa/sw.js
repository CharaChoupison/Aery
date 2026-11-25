/**
 * Service worker d'Aery (version web seulement, jamais dans l'appli Tauri).
 *
 * Rôle : garder l'interface sur l'appareil pour qu'elle s'ouvre même quand le serveur est injoignable
 * (Tailscale déconnecté, pas de réseau). Les données, elles, sont déjà sur l'appareil (IndexedDB).
 *
 * Ce fichier est un modèle : pwa/plugin.ts remplace __VERSION__ et __FILES__ au build et l'écrit
 * dans dist/sw.js. Une nouvelle version = un nouveau cache, l'ancien est supprimé à l'activation.
 *
 * Règles :
 *  - seuls les fichiers de l'interface (dist) sont gardés. /v1, /api, /admin, /sync ne passent
 *    JAMAIS par le cache : réponses des modèles, réglages et synchro vont toujours au réseau ;
 *  - page (navigation) : réseau d'abord, la page gardée si le serveur ne répond pas (ou en 4 s) ;
 *  - fichiers : cache d'abord (leurs noms changent à chaque version, ils ne bougent jamais).
 */
const CACHE = 'aery-__VERSION__'
const FILES = __FILES__
const FILE_SET = new Set(FILES)
const NETWORK_TIMEOUT = 4000
const NEVER_CACHED = ['/v1/', '/api/', '/admin/', '/sync/']
// Les fichiers sont les mêmes quels que soient les en-têtes de la requête. Sans ça, un `Vary: Origin`
// (ajouté par certains serveurs) empêche de retrouver les scripts « module », qui envoient Origin.
const MATCH = { ignoreVary: true }

self.addEventListener('install', (event) => {
  // cache: 'reload' : on veut les fichiers du serveur, pas ceux du cache HTTP du navigateur.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' })))))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('aery-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (NEVER_CACHED.some((prefix) => url.pathname.startsWith(prefix))) return
  if (request.mode === 'navigate') event.respondWith(page(request))
  else if (FILE_SET.has(url.pathname) || url.pathname.startsWith('/assets/')) event.respondWith(file(request, url))
})

/** La page : réseau d'abord ; si le serveur ne répond pas, la page gardée (elle va avec les fichiers gardés). */
async function page(request) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match('/', MATCH)
  if (!kept) return fetch(request)
  try {
    const res = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), NETWORK_TIMEOUT)),
    ])
    // 5xx = serveur Aery arrêté ou en redémarrage. Un 403 (compte non autorisé), lui, est montré tel quel.
    return res.status >= 500 ? kept : res
  } catch {
    return kept
  }
}

/** Un fichier de l'interface : cache d'abord, sinon réseau (et on le garde s'il est dans /assets). */
async function file(request, url) {
  const cache = await caches.open(CACHE)
  const kept = await cache.match(request, MATCH)
  if (kept) return kept
  const res = await fetch(request)
  if (res.ok && url.pathname.startsWith('/assets/')) await cache.put(request, res.clone())
  return res
}
