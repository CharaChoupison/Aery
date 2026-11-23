/**
 * Synchro entre appareils (côté serveur) : une copie de référence de la base IndexedDB d'Aery,
 * gardée dans SQLite (node:sqlite, inclus dans Node ≥ 22.13 : aucune dépendance).
 *
 * Principe (une seule personne, plusieurs appareils) :
 *  - chaque enregistrement (conversation, projet, élément du cerveau…) est une ligne
 *    { table, id, at, deleted, data } ; `at` = moment de la dernière modification sur l'appareil ;
 *  - POST /sync/push : l'appareil envoie ses changements. Pour chaque ligne, LE PLUS RÉCENT GAGNE
 *    (`at`) ; une suppression est gardée comme « pierre tombale » (sinon un autre appareil la ferait revivre) ;
 *  - GET /sync/pull?since=N : l'appareil récupère tout ce qui a changé depuis son curseur `N`
 *    (`seq` = compteur qui augmente à chaque écriture), par pages de quelques Mo ;
 *  - GET /sync/status : identifiant de cette base (`serverId`). S'il change (base recréée),
 *    les appareils renvoient tout ce qu'ils ont.
 *
 * Le contrôle d'accès (compte Tailscale + anti-CSRF) est fait AVANT, par standalone.ts.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import type http from 'node:http'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sendError, sendJson } from './backend.ts'

/** Tables synchronisées (mêmes noms que dans src/lib/db.ts). */
export const SYNC_TABLES = ['conversations', 'projects', 'brain', 'brainVersions', 'tidyRuns'] as const

const MAX_PUSH_BYTES = 64 * 1024 * 1024 // un envoi (plusieurs enregistrements, images comprises)
const MAX_RECORD_BYTES = 25 * 1024 * 1024 // un seul enregistrement (conversation avec images)
const PULL_PAGE_BYTES = 4 * 1024 * 1024 // taille visée d'une page de /sync/pull
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
const BACKUPS_KEPT = 7

interface Change {
  table: string
  id: string
  at: number
  deleted: boolean
  data?: unknown
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Vérifie un changement reçu ; renvoie un message d'erreur, ou null s'il est valide. */
export function invalidChange(c: unknown): string | null {
  if (typeof c !== 'object' || c === null) return 'Changement invalide.'
  const { table, id, at, deleted, data } = c as Record<string, unknown>
  if (typeof table !== 'string' || !(SYNC_TABLES as readonly string[]).includes(table)) return 'Table inconnue.'
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) return 'Identifiant invalide.'
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > Date.now() + 7 * 24 * 3600_000) return 'Date invalide.'
  if (typeof deleted !== 'boolean') return 'Champ deleted invalide.'
  if (!deleted) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return 'Données invalides.'
    if ((data as { id?: unknown }).id !== id) return 'Identifiant incohérent.'
  }
  return null
}

export function createSync(dbFile: string) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(dbFile)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS records (
      tbl     TEXT    NOT NULL,
      id      TEXT    NOT NULL,
      at      INTEGER NOT NULL,
      deleted INTEGER NOT NULL,
      data    TEXT,
      seq     INTEGER NOT NULL,
      PRIMARY KEY (tbl, id)
    );
    CREATE INDEX IF NOT EXISTS records_seq ON records (seq);
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `)
  fs.chmodSync(dbFile, 0o600)

  const getMeta = db.prepare('SELECT v FROM meta WHERE k = ?')
  const setMeta = db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v')
  let serverId = (getMeta.get('serverId') as { v: string } | undefined)?.v
  if (!serverId) {
    serverId = crypto.randomUUID()
    setMeta.run('serverId', serverId)
  }
  let seq = Number((getMeta.get('seq') as { v: string } | undefined)?.v ?? 0)

  const getAt = db.prepare('SELECT at FROM records WHERE tbl = ? AND id = ?')
  const upsert = db.prepare(`
    INSERT INTO records (tbl, id, at, deleted, data, seq) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (tbl, id) DO UPDATE SET at = excluded.at, deleted = excluded.deleted, data = excluded.data, seq = excluded.seq
  `)
  const pullStmt = db.prepare('SELECT tbl, id, at, deleted, data, seq FROM records WHERE seq > ? ORDER BY seq LIMIT 500')
  const countStmt = db.prepare('SELECT tbl, COUNT(*) AS n FROM records WHERE deleted = 0 GROUP BY tbl')

  /** Enregistre les changements (le plus récent gagne). Tout ou rien. */
  function push(changes: Change[]): { accepted: number; ignored: number } {
    let accepted = 0
    let ignored = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const c of changes) {
        const existing = getAt.get(c.table, c.id) as { at: number } | undefined
        if (existing && existing.at >= c.at) {
          ignored++
          continue
        }
        seq++
        upsert.run(c.table, c.id, Math.round(c.at), c.deleted ? 1 : 0, c.deleted ? null : JSON.stringify(c.data), seq)
        accepted++
      }
      setMeta.run('seq', String(seq))
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      seq = Number((getMeta.get('seq') as { v: string } | undefined)?.v ?? 0)
      throw e
    }
    return { accepted, ignored }
  }

  /** Ce qui a changé après `since`, par page d'environ PULL_PAGE_BYTES. */
  function pull(since: number): { changes: Change[]; cursor: number; more: boolean } {
    const changes: Change[] = []
    let cursor = since
    let bytes = 0
    for (;;) {
      const rows = pullStmt.all(cursor) as { tbl: string; id: string; at: number; deleted: number; data: string | null; seq: number }[]
      if (rows.length === 0) return { changes, cursor, more: false }
      for (const r of rows) {
        // Au moins un enregistrement par page, même s'il est gros.
        if (changes.length > 0 && bytes + (r.data?.length ?? 0) > PULL_PAGE_BYTES) return { changes, cursor, more: true }
        bytes += r.data?.length ?? 0
        changes.push({
          table: r.tbl,
          id: r.id,
          at: r.at,
          deleted: r.deleted === 1,
          ...(r.data !== null && { data: JSON.parse(r.data) as unknown }),
        })
        cursor = r.seq
      }
    }
  }

  // --- Copie de sécurité quotidienne (VACUUM INTO), 7 gardées --------------------------
  const backupDir = path.join(path.dirname(dbFile), 'sync-backups')
  function backupIfNeeded(): void {
    try {
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
      const today = new Date().toISOString().slice(0, 10)
      const target = path.join(backupDir, `sync-${today}.db`)
      if (fs.existsSync(target)) return
      db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)
      fs.chmodSync(target, 0o600)
      const old = fs
        .readdirSync(backupDir)
        .filter((f) => /^sync-\d{4}-\d{2}-\d{2}\.db$/.test(f))
        .sort()
        .slice(0, -BACKUPS_KEPT)
      for (const f of old) fs.rmSync(path.join(backupDir, f))
    } catch (e) {
      console.warn('[aery] Copie de sécurité de la synchro impossible :', e)
    }
  }
  backupIfNeeded()
  setInterval(backupIfNeeded, 3600_000).unref()

  // --- Routes ---------------------------------------------------------------------------

  async function handlePush(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.headers['content-type']?.startsWith('application/json')) {
      sendError(res, 415, 'bad_content_type', 'Content-Type application/json attendu')
      return
    }
    let body: unknown
    try {
      body = JSON.parse((await readBody(req, MAX_PUSH_BYTES)).toString('utf8'))
    } catch (e) {
      const tooLarge = (e as Error).message === 'too_large'
      sendError(res, tooLarge ? 413 : 400, tooLarge ? 'too_large' : 'bad_request', tooLarge ? 'Envoi trop gros.' : 'JSON invalide.')
      return
    }
    const changes = (body as { changes?: unknown })?.changes
    if (!Array.isArray(changes) || changes.length > 5000) {
      sendError(res, 400, 'bad_request', 'Liste de changements attendue.')
      return
    }
    for (const c of changes) {
      const error = invalidChange(c)
      if (error) {
        sendError(res, 400, 'invalid_change', error)
        return
      }
      if (!(c as Change).deleted && JSON.stringify((c as Change).data).length > MAX_RECORD_BYTES) {
        sendError(res, 413, 'record_too_large', 'Un élément est trop gros pour être synchronisé.')
        return
      }
    }
    sendJson(res, 200, { serverId, ...push(changes as Change[]) })
  }

  /** Gère /sync/*. Renvoie false pour toute autre adresse. */
  function handle(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const [pathname, query = ''] = (req.url ?? '').split('?', 2)
    if (!pathname.startsWith('/sync/')) return false

    if (pathname === '/sync/status' && req.method === 'GET') {
      const counts = Object.fromEntries((countStmt.all() as { tbl: string; n: number }[]).map((r) => [r.tbl, r.n]))
      sendJson(res, 200, { serverId, seq, counts })
    } else if (pathname === '/sync/pull' && req.method === 'GET') {
      const since = Number(new URLSearchParams(query).get('since') ?? 0)
      if (!Number.isInteger(since) || since < 0) {
        sendError(res, 400, 'bad_request', 'Curseur invalide.')
        return true
      }
      sendJson(res, 200, { serverId, ...pull(since) })
    } else if (pathname === '/sync/push' && req.method === 'POST') {
      handlePush(req, res).catch(() => {
        if (!res.headersSent) sendError(res, 500, 'internal', 'Erreur interne')
      })
    } else {
      sendError(res, 404, 'not_found', 'Introuvable')
    }
    return true
  }

  return { handle, push, pull, close: () => db.close() }
}
