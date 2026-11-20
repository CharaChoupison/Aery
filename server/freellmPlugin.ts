/**
 * Plugin Vite = notre mini « backend » local.
 *
 * Il fait deux choses :
 *  1. /api/settings : enregistre la clé FreeLLMAPI et le port dans un fichier
 *     protégé, HORS du projet (~/.freellm-chat/config.json, droits 600).
 *     Le navigateur peut écrire la clé, mais ne peut jamais la relire.
 *  2. /v1/* : relaie les requêtes vers FreeLLMAPI (127.0.0.1:<port>) en
 *     ajoutant lui-même l'en-tête Authorization. Le streaming SSE passe tel quel,
 *     et si le navigateur annule (bouton Stop), la requête amont est coupée aussi.
 *
 *  3. /admin/* : statistiques de FreeLLMAPI (analytique, journaux, scores, utilisation) en lecture,
 *     plus QUATRE écritures précises (activer un modèle, stratégie de routage, ajouter / supprimer une clé).
 *     Tout le reste est refusé. Voir la section dédiée plus bas.
 *
 * Dans l'appli Tauri, ce rôle est tenu par la partie Rust (src-tauri/src/proxy.rs et admin.rs).
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

type IncomingMessage = Connect.IncomingMessage
type ServerResponse = http.ServerResponse

interface Config {
  apiKey?: string
  port: number
}

const DEFAULT_PORT = 31415
const CONFIG_DIR = path.join(os.homedir(), '.freellm-chat')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')
const MAX_BODY_BYTES = 10 * 1024 * 1024 // 10 Mo (assez pour de longues conversations / images plus tard)

// Caractères ASCII imprimables, sans espace : empêche toute injection d'en-tête HTTP.
const KEY_PATTERN = /^[\x21-\x7E]{8,512}$/

// ---------------------------------------------------------------------------
// Lecture / écriture de la config
// ---------------------------------------------------------------------------

function readConfig(): Config {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as Partial<Config>
    return {
      apiKey: typeof raw.apiKey === 'string' && KEY_PATTERN.test(raw.apiKey) ? raw.apiKey : undefined,
      port: isValidPort(raw.port) ? raw.port : DEFAULT_PORT,
    }
  } catch {
    return { port: DEFAULT_PORT }
  }
}

function writeConfig(config: Config): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  // Écriture atomique : fichier temporaire puis renommage, pour ne jamais laisser un fichier à moitié écrit.
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, CONFIG_FILE)
  fs.chmodSync(CONFIG_FILE, 0o600)
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}

/** « freellmapi-abcdef123456 » → « freellmapi-…3456 » */
function keyHint(key: string): string {
  const prefix = key.startsWith('freellmapi-') ? 'freellmapi-' : ''
  return `${prefix}…${key.slice(-4)}`
}

// ---------------------------------------------------------------------------
// Petits utilitaires HTTP
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } })
}

/**
 * Protection CSRF : un site web malveillant ouvert dans ton navigateur pourrait
 * essayer d'appeler http://localhost:5173 pour changer ta clé ou utiliser tes quotas.
 * On n'accepte donc que les requêtes venant de notre propre page (même origine),
 * ou d'outils locaux sans navigateur (curl…), qui n'envoient pas ces en-têtes.
 */
function isTrustedRequest(req: IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false
  // Notre page n'appelle ces routes qu'avec fetch() (« empty »). Un `import()` lancé depuis le bac à
  // sable de l'agent (outil run_js) arriverait en « script » : refusé, même s'il est de même origine.
  const fetchDest = req.headers['sec-fetch-dest']
  if (fetchDest && fetchDest !== 'empty') return false

  const origin = req.headers.origin
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }
  return true
}

function readJsonBody(req: IncomingMessage, maxBytes = 10 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Corps de requête trop gros'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('JSON invalide'))
      }
    })
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// /api/settings
// ---------------------------------------------------------------------------

async function handleSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET') {
    const { apiKey, port } = readConfig()
    // On ne renvoie JAMAIS la clé elle-même, seulement un indice.
    sendJson(res, 200, { hasKey: Boolean(apiKey), keyHint: apiKey ? keyHint(apiKey) : null, port })
    return
  }

  if (req.method === 'PUT') {
    // Exiger du JSON force le navigateur à faire une requête « preflight » en cross-origin,
    // qu'on ne valide jamais : double protection contre le CSRF.
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(res, 415, 'bad_content_type', 'Content-Type application/json attendu')
      return
    }

    let body: { apiKey?: unknown; port?: unknown }
    try {
      body = (await readJsonBody(req)) as typeof body
    } catch (e) {
      sendError(res, 400, 'bad_request', (e as Error).message)
      return
    }
    if (typeof body !== 'object' || body === null) {
      sendError(res, 400, 'bad_request', 'Objet JSON attendu')
      return
    }

    const config = readConfig()

    if (body.apiKey === null) {
      delete config.apiKey // suppression de la clé
    } else if (body.apiKey !== undefined) {
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (!KEY_PATTERN.test(key)) {
        sendError(res, 400, 'invalid_key', 'Clé invalide : pas d’espaces, entre 8 et 512 caractères.')
        return
      }
      config.apiKey = key
    }

    if (body.port !== undefined) {
      if (!isValidPort(body.port)) {
        sendError(res, 400, 'invalid_port', 'Le port doit être un entier entre 1 et 65535.')
        return
      }
      config.port = body.port
    }

    writeConfig(config)
    sendJson(res, 200, {
      hasKey: Boolean(config.apiKey),
      keyHint: config.apiKey ? keyHint(config.apiKey) : null,
      port: config.port,
    })
    return
  }

  sendError(res, 405, 'method_not_allowed', 'Méthode non autorisée')
}

// ---------------------------------------------------------------------------
// /v1/* → FreeLLMAPI
// ---------------------------------------------------------------------------

// En-têtes du navigateur qu'on ne transmet pas à FreeLLMAPI.
const DROPPED_REQUEST_HEADERS = ['host', 'origin', 'referer', 'cookie', 'authorization', 'connection']

function proxyToFreeLLM(req: IncomingMessage, res: ServerResponse): void {
  const { apiKey, port } = readConfig()
  if (!apiKey) {
    sendError(res, 401, 'no_key', 'Aucune clé FreeLLMAPI configurée. Ouvre les Paramètres pour la coller.')
    return
  }

  const headers: http.OutgoingHttpHeaders = { ...req.headers }
  for (const h of DROPPED_REQUEST_HEADERS) delete headers[h]
  headers.authorization = `Bearer ${apiKey}`

  // L'hôte est figé à 127.0.0.1 : impossible de détourner le proxy vers une autre machine.
  const upstream = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers)
      upRes.pipe(res) // le SSE est relayé morceau par morceau
    },
  )

  upstream.on('error', () => {
    if (!res.headersSent) {
      sendError(
        res,
        502,
        'upstream_unreachable',
        `FreeLLMAPI ne répond pas sur le port ${port}. Vérifie que l’appli est lancée (et le port dans les Paramètres).`,
      )
    } else {
      res.destroy()
    }
  })

  // Bouton Stop : si le navigateur coupe la connexion, on coupe aussi vers FreeLLMAPI.
  res.on('close', () => {
    if (!res.writableFinished) upstream.destroy()
  })

  let size = 0
  req.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      upstream.destroy()
      if (!res.headersSent) sendError(res, 413, 'too_large', 'Requête trop volumineuse')
    }
  })
  req.pipe(upstream)
}

// ---------------------------------------------------------------------------
// /admin/* → API du dashboard FreeLLMAPI (lecture seule)
// ---------------------------------------------------------------------------
//
// Les pages Analytique / Journaux / Modèles de FreeLLMAPI passent par son API d'admin
// (/api/...), protégée par une SESSION du dashboard, pas par la clé freellmapi-.
// L'appli desktop FreeLLMAPI donne cette session à tout programme local qui la demande
// (POST /api/auth/desktop-session, refusé si la requête vient d'une page web).
//
// Ce jeton donne TOUS les droits d'admin (clés, réglages…). Donc :
//  - il reste ici, en mémoire : le navigateur ne le voit jamais ;
//  - en GET, seules les routes de lecture listées ci-dessous passent. Aucune ne renvoie une clé
//    en clair (/api/keys ne donne que des clés masquées ; /api/keys/export et /reveal restent bloquées) ;
//  - en écriture, seules quatre opérations passent (voir adminWrite), avec un corps REVALIDÉ et
//    reconstruit ici : on ne relaie jamais tel quel ce qu'envoie la page.

const ADMIN_ROUTES: RegExp[] = [
  /^\/api\/analytics\/(summary|timeline|by-model|by-platform|error-distribution|errors|requests)$/,
  /^\/api\/analytics\/requests\/\d{1,12}$/,
  /^\/api\/logs$/,
  /^\/api\/fallback$/,
  /^\/api\/fallback\/(routing|token-usage|rate-limit-usage|quota-forecast)$/,
  /^\/api\/keys$/,
  /^\/api\/keys\/providers$/,
]
// Paramètres de requête : caractères simples seulement (range=7d&levels=warn,error&q=…).
const SAFE_QUERY = /^[A-Za-z0-9_\-.,=&%+:*]*$/

/** « /admin/logs?limit=200 » → « /api/logs?limit=200 », ou null si la route n'est pas autorisée. */
export function adminApiPath(url: string): string | null {
  if (!url.startsWith('/admin/')) return null
  const [pathname, query = ''] = url.split(/\?(.*)/s, 2)
  const apiPath = `/api/${pathname.slice('/admin/'.length)}`
  if (!ADMIN_ROUTES.some((re) => re.test(apiPath)) || !SAFE_QUERY.test(query) || query.length > 512) return null
  return query ? `${apiPath}?${query}` : apiPath
}

// --- Écritures autorisées ---------------------------------------------------------------

const PLATFORM_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/
// Clé d'un fournisseur : ASCII imprimable sans espace (comme notre propre clé), 4096 caractères max.
const PROVIDER_KEY_PATTERN = /^[\x21-\x7E]{1,4096}$/

const ROUTING_STRATEGIES = ['priority', 'balanced', 'smartest', 'fastest', 'reliable', 'custom', 'decision']

export interface AdminWrite {
  method: 'PUT' | 'POST' | 'DELETE'
  apiPath: string
  body?: string
}

/**
 * Les seules écritures autorisées. Renvoie la requête à faire (corps reconstruit), ou un message d'erreur.
 *  - PUT    /admin/fallback   : activer / désactiver des modèles  [{ modelDbId, priority, enabled }]
 *  - PUT    /admin/fallback/routing : stratégie de routage     { strategy, weights? } (rien d'autre)
 *  - POST   /admin/keys       : ajouter une clé de fournisseur     { platform, key?, label? } (pas de proxyUrl)
 *  - DELETE /admin/keys/<id>  : supprimer une clé
 */
export function adminWrite(method: string, url: string, body: unknown): AdminWrite | string {
  if (url.includes('?')) return 'Paramètres non autorisés.'

  if (method === 'PUT' && url === '/admin/fallback') {
    if (!Array.isArray(body) || body.length === 0 || body.length > 2000) return 'Liste de modèles attendue.'
    const entries: { modelDbId: number; priority: number; enabled: boolean }[] = []
    for (const e of body as unknown[]) {
      const { modelDbId, priority, enabled } = (e ?? {}) as Record<string, unknown>
      if (
        !Number.isInteger(modelDbId) || (modelDbId as number) < 1 || (modelDbId as number) > 1e12 ||
        !Number.isInteger(priority) || (priority as number) < 0 || (priority as number) > 1e6 ||
        typeof enabled !== 'boolean'
      )
        return 'Modèle invalide.'
      entries.push({ modelDbId: modelDbId as number, priority: priority as number, enabled })
    }
    return { method: 'PUT', apiPath: '/api/fallback', body: JSON.stringify(entries) }
  }

  if (method === 'PUT' && url === '/admin/fallback/routing') {
    // FreeLLMAPI ne modifie que les champs reçus : en n'envoyant que ceux-là, on ne touche pas
    // aux autres réglages du routeur (heures de pointe, modèle de décision, cooldowns…).
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Objet JSON attendu.'
    const { strategy, weights } = body as Record<string, unknown>
    if (typeof strategy !== 'string' || !ROUTING_STRATEGIES.includes(strategy)) return 'Stratégie inconnue.'
    if (weights === undefined) return { method: 'PUT', apiPath: '/api/fallback/routing', body: JSON.stringify({ strategy }) }
    const w = (weights ?? {}) as Record<string, unknown>
    const values = (['reliability', 'speed', 'intelligence'] as const).map((k) => w[k])
    if (!values.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1000) || values.every((v) => v === 0))
      return 'Poids invalides.'
    const [reliability, speed, intelligence] = values as number[]
    return {
      method: 'PUT',
      apiPath: '/api/fallback/routing',
      body: JSON.stringify({ strategy, weights: { reliability, speed, intelligence } }),
    }
  }

  if (method === 'POST' && url === '/admin/keys') {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'Objet JSON attendu.'
    const b = body as Record<string, unknown>
    if (typeof b.platform !== 'string' || !PLATFORM_PATTERN.test(b.platform) || b.platform === 'custom')
      return 'Fournisseur invalide.'
    const key = typeof b.key === 'string' ? b.key.trim() : ''
    if (b.key !== undefined && typeof b.key !== 'string') return 'Clé invalide.'
    if (key && !PROVIDER_KEY_PATTERN.test(key)) return 'Clé invalide : pas d’espaces, 4096 caractères maximum.'
    let label = ''
    if (b.label !== undefined) {
      if (typeof b.label !== 'string') return 'Nom invalide.'
      label = b.label.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
      if (label.length > 64) return 'Nom trop long (64 caractères maximum).'
    }
    return {
      method: 'POST',
      apiPath: '/api/keys',
      body: JSON.stringify({ platform: b.platform, ...(key && { key }), ...(label && { label }) }),
    }
  }

  const deleteMatch = /^\/admin\/keys\/(\d{1,12})$/.exec(url)
  if (method === 'DELETE' && deleteMatch) return { method: 'DELETE', apiPath: `/api/keys/${deleteMatch[1]}` }

  return 'Cette action n’est pas autorisée depuis le chat.'
}

interface UpstreamResult {
  status: number
  contentType: string
  body: Buffer
}

/** Requête simple vers FreeLLMAPI, réponse lue en entier (les réponses admin sont petites). */
function upstreamRequest(port: number, method: string, path: string, headers: http.OutgoingHttpHeaders, body?: string) {
  return new Promise<UpstreamResult>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, timeout: 15_000 }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 502,
          contentType: String(res.headers['content-type'] ?? 'application/json'),
          body: Buffer.concat(chunks),
        }),
      )
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

class AdminError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

let dashboardSession: { port: number; token: string } | null = null

/** Jeton de session du dashboard (gardé en mémoire ; redemandé s'il a expiré ou si le port change). */
async function getDashboardToken(port: number, refresh = false): Promise<string> {
  if (!refresh && dashboardSession?.port === port) return dashboardSession.token
  const res = await upstreamRequest(port, 'POST', '/api/auth/desktop-session', { 'content-type': 'application/json' }, '{}')
  if (res.status === 403) {
    throw new AdminError(
      403,
      'desktop_only',
      'Les statistiques ne sont disponibles qu’avec l’appli desktop FreeLLMAPI lancée sur cet ordinateur.',
    )
  }
  const token = (JSON.parse(res.body.toString('utf8')) as { token?: unknown }).token
  if (res.status !== 200 || typeof token !== 'string' || !/^[A-Za-z0-9]{16,256}$/.test(token)) {
    throw new AdminError(502, 'no_session', 'FreeLLMAPI n’a pas ouvert de session pour les statistiques.')
  }
  dashboardSession = { port, token }
  return token
}

async function handleAdmin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? ''
  let target: { method: string; apiPath: string; body?: string }

  if (req.method === 'GET') {
    const apiPath = adminApiPath(url)
    if (!apiPath) {
      sendError(res, 404, 'not_allowed', 'Cette route de FreeLLMAPI n’est pas accessible depuis le chat.')
      return
    }
    target = { method: 'GET', apiPath }
  } else if (req.method === 'PUT' || req.method === 'POST' || req.method === 'DELETE') {
    let body: unknown
    if (req.method !== 'DELETE') {
      // Même règle que /api/settings : du JSON obligatoire (force un « preflight » en cross-origin).
      if (!req.headers['content-type']?.startsWith('application/json')) {
        sendError(res, 415, 'bad_content_type', 'Content-Type application/json attendu')
        return
      }
      try {
        body = await readJsonBody(req, 256 * 1024)
      } catch (e) {
        sendError(res, 400, 'bad_request', (e as Error).message)
        return
      }
    }
    const write = adminWrite(req.method, url, body)
    if (typeof write === 'string') {
      sendError(res, 403, 'not_allowed', write)
      return
    }
    target = write
  } else {
    sendError(res, 405, 'method_not_allowed', 'Méthode non autorisée.')
    return
  }

  const { port } = readConfig()
  try {
    const send = async (token: string) =>
      upstreamRequest(
        port,
        target.method,
        target.apiPath,
        { authorization: `Bearer ${token}`, ...(target.body !== undefined && { 'content-type': 'application/json' }) },
        target.body,
      )
    let result = await send(await getDashboardToken(port))
    // Session expirée (30 jours) ou FreeLLMAPI redémarré : on en redemande une, une seule fois.
    if (result.status === 401) result = await send(await getDashboardToken(port, true))
    res.statusCode = result.status
    res.setHeader('Content-Type', result.contentType)
    res.setHeader('Cache-Control', 'no-store')
    res.end(result.body)
  } catch (e) {
    if (e instanceof AdminError) sendError(res, e.status, e.code, e.message)
    else
      sendError(
        res,
        502,
        'upstream_unreachable',
        `FreeLLMAPI ne répond pas sur le port ${port}. Vérifie que l’appli est lancée.`,
      )
  }
}

// ---------------------------------------------------------------------------
// Le plugin
// ---------------------------------------------------------------------------

function middleware(req: IncomingMessage, res: ServerResponse, next: Connect.NextFunction): void {
  const url = req.url ?? ''
  const isApi = url === '/api/settings'
  const isProxy = url.startsWith('/v1/')
  const isAdmin = url.startsWith('/admin/')
  if (!isApi && !isProxy && !isAdmin) return next()

  if (!isTrustedRequest(req)) {
    sendError(res, 403, 'forbidden_origin', 'Origine non autorisée')
    return
  }

  if (isApi || isAdmin) {
    ;(isApi ? handleSettings(req, res) : handleAdmin(req, res)).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'internal', 'Erreur interne')
    })
  } else {
    proxyToFreeLLM(req, res)
  }
}

export function freellmPlugin(): Plugin {
  return {
    name: 'freellm-backend',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
