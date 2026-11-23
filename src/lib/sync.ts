/**
 * Synchro entre appareils (côté appareil). Le serveur (server/sync.ts) garde la copie de référence.
 *
 * Un tour de synchro :
 *  1. /sync/status : identifiant de la base du serveur. S'il est nouveau pour cet appareil
 *     (premier branchement, ou base recréée), on renvoie TOUT ce qu'on a ;
 *  2. envoi : la boîte d'envoi (remplie par les hooks de src/lib/db.ts), par lots de quelques Mo ;
 *  3. réception : tout ce qui a changé depuis notre curseur, appliqué dans IndexedDB
 *     (le plus récent gagne), puis l'événement `aery:sync-applied` prévient les écrans.
 *
 * Quand : au lancement, au retour du réseau, quand l'appli revient au premier plan, toutes les 30 s,
 * et quelques secondes après une modification. Hors ligne, la boîte d'envoi attend : rien n'est perdu.
 * Sans serveur de synchro (npm run dev), /sync répond 404 : on réessaie seulement toutes les 5 min.
 */
import { useSyncExternalStore } from 'react'
import {
  applyRemoteChanges,
  clearSentOutbox,
  enqueueEverything,
  getSyncRecords,
  getSyncState,
  onLocalChange,
  readOutbox,
  setSyncState,
  SYNC_TABLES,
  type AppliedChanges,
  type SyncChange,
  type SyncOutboxEntry,
  type SyncTable,
} from '@/lib/db'
import { appFetch } from '@/lib/transport'

export const SYNC_APPLIED_EVENT = 'aery:sync-applied'

const PERIOD = 30_000
const UNAVAILABLE_RETRY = 5 * 60_000
const AFTER_LOCAL_CHANGE = 2_500
const PUSH_BATCH_BYTES = 6 * 1024 * 1024

export type SyncPhase = 'idle' | 'syncing' | 'offline' | 'unavailable' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  lastSyncAt: number | null
  pending: number // changements locaux pas encore envoyés
  message: string | null
}

let status: SyncStatus = { phase: 'idle', lastSyncAt: null, pending: 0, message: null }
const listeners = new Set<() => void>()

function setStatus(patch: Partial<SyncStatus>): void {
  status = { ...status, ...patch }
  listeners.forEach((l) => l())
}

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status,
  )
}

class SyncHttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const res = await appFetch(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) })
  if (!res.ok) {
    let message = `Erreur ${res.status}`
    try {
      message = ((await res.json()) as { error?: { message?: string } }).error?.message ?? message
    } catch {
      // réponse non JSON
    }
    throw new SyncHttpError(res.status, message)
  }
  // Serveur de dev (Vite) : /sync/… renvoie la page HTML de l'appli = pas de serveur de synchro.
  if (!res.headers.get('content-type')?.includes('application/json')) throw new SyncHttpError(404, 'Pas de serveur de synchro.')
  return (await res.json()) as T
}

// --- Un tour de synchro ----------------------------------------------------------------------

async function push(): Promise<void> {
  const entries = await readOutbox()
  setStatus({ pending: entries.length })
  if (entries.length === 0) return

  // Lit les enregistrements (table par table) et prépare les changements à envoyer.
  const byTable = new Map<SyncTable, SyncOutboxEntry[]>()
  for (const e of entries) byTable.set(e.table, [...(byTable.get(e.table) ?? []), e])
  const prepared: { entry: SyncOutboxEntry; change: SyncChange; size: number }[] = []
  for (const [table, list] of byTable) {
    const records = await getSyncRecords(table, list.map((e) => e.id))
    list.forEach((entry, i) => {
      const record = records[i]
      const change: SyncChange =
        entry.deleted || !record
          ? { table, id: entry.id, at: entry.at, deleted: true }
          : { table, id: entry.id, at: entry.at, deleted: false, data: record }
      prepared.push({ entry, change, size: JSON.stringify(change).length })
    })
  }

  // Envoi par lots de quelques Mo (une conversation avec des images peut être lourde).
  let batch: typeof prepared = []
  let bytes = 0
  const flush = async () => {
    if (batch.length === 0) return
    await call('/sync/push', { changes: batch.map((p) => p.change) })
    await clearSentOutbox(batch.map((p) => p.entry))
    setStatus({ pending: Math.max(0, status.pending - batch.length) })
    batch = []
    bytes = 0
  }
  for (const p of prepared) {
    if (batch.length > 0 && (bytes + p.size > PUSH_BATCH_BYTES || batch.length >= 500)) await flush()
    batch.push(p)
    bytes += p.size
  }
  await flush()
}

function mergeApplied(into: AppliedChanges, from: AppliedChanges): void {
  for (const table of SYNC_TABLES) {
    const f = from[table]
    if (!f) continue
    const t = (into[table] ??= { put: [], deleted: [] })
    t.put.push(...f.put)
    t.deleted.push(...f.deleted)
  }
}

async function pull(): Promise<AppliedChanges> {
  const applied: AppliedChanges = {}
  let cursor = (await getSyncState<number>('cursor')) ?? 0
  for (let page = 0; page < 1000; page++) {
    const res = await call<{ changes: SyncChange[]; cursor: number; more: boolean }>(`/sync/pull?since=${cursor}`)
    mergeApplied(applied, await applyRemoteChanges(res.changes))
    cursor = res.cursor
    await setSyncState('cursor', cursor)
    if (!res.more) break
  }
  return applied
}

async function runOnce(): Promise<void> {
  const { serverId } = await call<{ serverId: string }>('/sync/status')
  if ((await getSyncState<string>('serverId')) !== serverId) {
    // Premier branchement (ou base du serveur recréée) : on lui donne tout ce qu'on a.
    await enqueueEverything()
    await setSyncState('cursor', 0)
    await setSyncState('serverId', serverId)
  }
  await push()
  const applied = await pull()
  if (SYNC_TABLES.some((t) => applied[t])) window.dispatchEvent(new CustomEvent<AppliedChanges>(SYNC_APPLIED_EVENT, { detail: applied }))
}

// --- Planification ---------------------------------------------------------------------------

let running: Promise<void> | null = null
let again = false
let unavailableUntil = 0

/** Lance un tour de synchro (ou en reprogramme un juste après celui en cours). */
export function syncNow(force = false): Promise<void> {
  if (!force && Date.now() < unavailableUntil) return Promise.resolve()
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    setStatus({ phase: 'syncing', message: null })
    try {
      await runOnce()
      unavailableUntil = 0
      setStatus({ phase: 'idle', lastSyncAt: Date.now(), message: null })
    } catch (e) {
      if (e instanceof SyncHttpError && (e.status === 404 || e.status === 403)) {
        // Pas de serveur de synchro ici (npm run dev, ou route refusée) : on ne s'acharne pas.
        unavailableUntil = Date.now() + UNAVAILABLE_RETRY
        setStatus({ phase: 'unavailable', message: e.status === 404 ? 'Pas de serveur de synchro.' : e.message })
      } else if (e instanceof SyncHttpError) {
        setStatus({ phase: 'error', message: e.message })
      } else {
        setStatus({ phase: navigator.onLine ? 'error' : 'offline', message: navigator.onLine ? 'Serveur injoignable.' : null })
      }
    } finally {
      setStatus({ pending: (await readOutbox().catch(() => [])).length })
      running = null
      if (again) {
        again = false
        void syncNow()
      }
    }
  })()
  return running
}

let started = false

/** Démarre la synchro automatique (une fois, au lancement de l'appli). */
export function startSync(): void {
  if (started) return
  started = true
  let debounce: ReturnType<typeof setTimeout> | undefined
  onLocalChange(() => {
    clearTimeout(debounce)
    debounce = setTimeout(() => void syncNow(), AFTER_LOCAL_CHANGE)
  })
  window.addEventListener('online', () => void syncNow(true))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncNow()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow()
  }, PERIOD)
  setTimeout(() => void syncNow(), 1_000)
}
