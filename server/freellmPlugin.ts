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
 *  3. /admin/* : statistiques de FreeLLMAPI (analytique, journaux, scores des modèles),
 *     en LECTURE SEULE et sur une liste blanche de routes. Voir la section dédiée plus bas.
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
//  - seules des routes de LECTURE, listées ci-dessous, sont relayées, et seulement en GET.

const ADMIN_ROUTES: RegExp[] = [
  /^\/api\/analytics\/(summary|timeline|by-model|by-platform|error-distribution|errors|requests)$/,
  /^\/api\/analytics\/requests\/\d{1,12}$/,
  /^\/api\/logs$/,
  /^\/api\/fallback$/,
  /^\/api\/fallback\/routing$/,
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
  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Lecture seule : seule la méthode GET est autorisée.')
    return
  }
  const apiPath = adminApiPath(req.url ?? '')
  if (!apiPath) {
    sendError(res, 404, 'not_allowed', 'Cette route de FreeLLMAPI n’est pas accessible depuis le chat.')
    return
  }
  const { port } = readConfig()
  try {
    const get = async (token: string) => upstreamRequest(port, 'GET', apiPath, { authorization: `Bearer ${token}` })
    let result = await get(await getDashboardToken(port))
    // Session expirée (30 jours) ou FreeLLMAPI redémarré : on en redemande une, une seule fois.
    if (result.status === 401) result = await get(await getDashboardToken(port, true))
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
