/**
 * Serveur autonome d'Aery (version web hébergée, ex. sur pronoti derrière Tailscale).
 *
 * Il sert l'interface construite (dist/) et le même backend que le plugin Vite (server/backend.ts) :
 * /api/settings, /v1/* (proxy vers FreeLLMAPI, clé ajoutée ici) et /admin/* (listes blanches).
 *
 * Lancement : node server/standalone.ts   (Node ≥ 22.18 lit le TypeScript directement)
 *
 * Sécurité :
 *  - il n'écoute QUE sur 127.0.0.1 : on y accède uniquement via `tailscale serve` (HTTPS) ;
 *  - `tailscale serve` ajoute l'en-tête Tailscale-User-Login : seuls les comptes de
 *    AERY_ALLOWED_USERS passent, même pour les fichiers de l'interface ;
 *  - la clé freellmapi- et le compte d'admin restent sur le serveur, jamais envoyés au navigateur.
 *
 * Variables d'environnement :
 *  AERY_PORT              port local (défaut 3080)
 *  AERY_CONFIG_FILE       fichier de la clé et du port (défaut ./data/config.json)
 *  AERY_DIST              dossier de l'interface construite (défaut ../dist)
 *  AERY_ALLOWED_USERS     comptes Tailscale autorisés, séparés par des virgules (OBLIGATOIRE)
 *  FREELLM_PORT           port de FreeLLMAPI (défaut 3001)
 *  FREELLM_ADMIN_EMAIL    compte du dashboard FreeLLMAPI (pages Modèles, Clés, Utilisation, Analytique)
 *  FREELLM_ADMIN_PASSWORD (sur le serveur : plutôt le fichier freellm-admin de systemd, voir readAdminLogin)
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { createBackend, sendError } from './backend.ts'

function fail(message: string): never {
  console.error(`[aery] ${message}`)
  process.exit(1)
}

const port = Number(process.env.AERY_PORT ?? 3080)
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('AERY_PORT invalide.')
const freellmPort = Number(process.env.FREELLM_PORT ?? 3001)
if (!Number.isInteger(freellmPort) || freellmPort < 1 || freellmPort > 65535) fail('FREELLM_PORT invalide.')

const distDir = path.resolve(process.env.AERY_DIST ?? path.join(import.meta.dirname, '..', 'dist'))
if (!fs.existsSync(path.join(distDir, 'index.html'))) fail(`Interface introuvable dans ${distDir} (lance npm run build).`)

const allowedUsers = (process.env.AERY_ALLOWED_USERS ?? '')
  .split(',')
  .map((u) => u.trim().toLowerCase())
  .filter(Boolean)
// Pas de liste = n'importe qui joignant le serveur utiliserait tes quotas : on refuse de démarrer.
if (allowedUsers.length === 0) fail('AERY_ALLOWED_USERS est obligatoire (ton compte Tailscale, ex. moi@github).')

/**
 * Compte d'admin FreeLLMAPI : variables FREELLM_ADMIN_EMAIL / FREELLM_ADMIN_PASSWORD, ou fichier
 * JSON { email, password } passé par systemd (LoadCredential=freellm-admin:…), lisible par ce service seul.
 */
function readAdminLogin(): { email?: string; password?: string } {
  const dir = process.env.CREDENTIALS_DIRECTORY
  if (dir) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'freellm-admin'), 'utf8')) as Record<string, unknown>
      if (typeof raw.email === 'string' && typeof raw.password === 'string') return { email: raw.email.trim(), password: raw.password }
    } catch {
      // fichier vide ou absent : pas de compte
    }
  }
  return { email: process.env.FREELLM_ADMIN_EMAIL?.trim(), password: process.env.FREELLM_ADMIN_PASSWORD }
}

const { email, password } = readAdminLogin()
if (Boolean(email) !== Boolean(password)) fail('Compte d’admin FreeLLMAPI incomplet (e-mail et mot de passe vont ensemble).')
if (!email) console.warn('[aery] Pas de compte d’admin FreeLLMAPI : les pages Modèles, Clés, Utilisation et Analytique ne marcheront pas.')

const backend = createBackend({
  configFile: path.resolve(process.env.AERY_CONFIG_FILE ?? path.join(import.meta.dirname, '..', 'data', 'config.json')),
  defaultPort: freellmPort,
  adminLogin: email && password ? { email, password } : undefined,
  allowedUsers,
})

// ---------------------------------------------------------------------------
// Fichiers de l'interface
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

// Même esprit que la CSP de l'appli Tauri : rien d'extérieur (scripts, images, connexions).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()')
}

/** Chemin sûr dans dist/, ou null (« .. », fichiers cachés, caractères bizarres). */
function resolveStatic(urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.split('/').some((part) => part.startsWith('.'))) return null
  const file = path.resolve(distDir, `.${decoded}`)
  return file === distDir || file.startsWith(distDir + path.sep) ? file : null
}

// ---------------------------------------------------------------------------
// Compression : via un relais Tailscale, le débit peut tomber à ~50 Ko/s. Le gros fichier JS
// (~1,4 Mo) est compressé UNE fois au démarrage (Brotli + gzip), puis servi depuis la mémoire.
// ---------------------------------------------------------------------------

const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg', '.txt', '.wasm'])
const compressed = new Map<string, { br: Buffer; gzip: Buffer }>()

async function precompress(dir: string): Promise<void> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath, entry.name)
    if (!COMPRESSIBLE.has(path.extname(file))) continue
    const raw = await fs.promises.readFile(file)
    if (raw.length < 1024) continue
    const [br, gzip] = await Promise.all([
      promisify(zlib.brotliCompress)(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } }),
      promisify(zlib.gzip)(raw, { level: 9 }),
    ])
    compressed.set(file, { br, gzip })
  }
}

precompress(distDir).then(
  () => console.log(`[aery] ${compressed.size} fichiers compressés en mémoire`),
  (e: unknown) => console.warn('[aery] Compression impossible, fichiers servis tels quels :', e),
)

function pickEncoding(req: http.IncomingMessage): 'br' | 'gzip' | null {
  const accept = String(req.headers['accept-encoding'] ?? '')
  if (/\bbr\b/.test(accept)) return 'br'
  if (/\bgzip\b/.test(accept)) return 'gzip'
  return null
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const ext = path.extname(file)
  const method = req.method ?? 'GET'
  res.statusCode = 200
  res.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream')
  if (COMPRESSIBLE.has(ext)) res.setHeader('Vary', 'Accept-Encoding')
  // Les fichiers de dist/assets ont une empreinte dans leur nom : on peut les garder longtemps.
  // index.html, lui, doit toujours être relu pour voir les nouvelles versions.
  res.setHeader(
    'Cache-Control',
    file.startsWith(path.join(distDir, 'assets') + path.sep) ? 'public, max-age=31536000, immutable' : 'no-cache',
  )
  const encoding = pickEncoding(req)
  const packed = encoding ? compressed.get(file) : undefined
  if (encoding && packed) {
    res.setHeader('Content-Encoding', encoding)
    res.setHeader('Content-Length', packed[encoding].length)
    res.end(method === 'HEAD' ? undefined : packed[encoding])
    return
  }
  if (method === 'HEAD') {
    res.end()
    return
  }
  fs.createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res)
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method_not_allowed', 'Méthode non autorisée')
    return
  }
  const urlPath = (req.url ?? '/').split('?')[0]
  const file = resolveStatic(urlPath)
  if (!file) {
    sendError(res, 404, 'not_found', 'Introuvable')
    return
  }
  fs.stat(file, (err, stat) => {
    if (!err && stat.isFile()) return serveFile(req, res, file)
    // Un fichier manquant dans /assets reste une 404 ; le reste renvoie l'appli (index.html).
    if (urlPath.startsWith('/assets/') || path.extname(urlPath)) {
      sendError(res, 404, 'not_found', 'Introuvable')
      return
    }
    serveFile(req, res, path.join(distDir, 'index.html'))
  })
}

// ---------------------------------------------------------------------------
// Le serveur
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  setSecurityHeaders(res)
  if (backend.handle(req, res)) return
  if (!backend.isAllowedUser(req)) {
    sendError(res, 403, 'forbidden_user', 'Accès refusé.')
    return
  }
  serveStatic(req, res)
})

// Les réponses en streaming peuvent rester silencieuses longtemps (fournisseurs saturés).
server.requestTimeout = 0
server.headersTimeout = 30_000
server.keepAliveTimeout = 65_000

server.listen(port, '127.0.0.1', () => {
  console.log(`[aery] Prêt sur http://127.0.0.1:${port} (FreeLLMAPI sur le port ${freellmPort}, ${allowedUsers.length} compte(s) autorisé(s))`)
})

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
