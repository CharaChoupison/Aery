import Dexie, { type EntityTable, type Transaction } from 'dexie'
import type { Conversation } from '@/hooks/useChat'
import type { Project } from '@/lib/projects'
import type { BrainItem, BrainVersion } from '@/lib/brain'
import type { TidyRun } from '@/lib/brainTidy'
import type { Attachment } from '@/lib/attachments'

/**
 * Base IndexedDB du chat (via Dexie).
 *
 * ⚠️ IndexedDB est liée à l'ORIGINE de la page (ex. http://localhost:5173) :
 * si le port change, le navigateur voit une autre base, vide. D'où strictPort dans vite.config.ts.
 */
const db = new Dexie('freellm-chat') as Dexie & {
  conversations: EntityTable<Conversation, 'id'>
  projects: EntityTable<Project, 'id'>
  brain: EntityTable<BrainItem, 'id'>
  brainVersions: EntityTable<BrainVersion, 'id'>
  tidyRuns: EntityTable<TidyRun, 'id'>
  syncOutbox: EntityTable<SyncOutboxEntry, 'key'>
  syncState: EntityTable<{ key: string; value: unknown }, 'key'>
}

// Version 1 du schéma : clé primaire « id », index sur « updatedAt » pour trier.
// Pour ajouter un champ indexé plus tard : db.version(2).stores({...}) — ne jamais modifier la version 1.
db.version(1).stores({
  conversations: 'id, updatedAt',
})

// Version 2 : les projets (dossiers de conversations). Les conversations existantes ne changent pas :
// elles n'ont simplement pas de projectId (= hors projet).
db.version(2).stores({
  conversations: 'id, updatedAt, projectId',
  projects: 'id, updatedAt',
})

// Version 3 : le second cerveau. Les fichiers de référence des projets y déménagent : chaque
// fichier devient un élément du cerveau rangé dans son projet (projectIds), et le projet n'en
// garde plus de copie. « *projectIds » / « *tags » = index sur chaque valeur du tableau.
db.version(3)
  .stores({
    conversations: 'id, updatedAt, projectId',
    projects: 'id, updatedAt',
    brain: 'id, updatedAt, kind, *projectIds, *tags',
  })
  .upgrade(async (tx) => {
    const projects = (await tx.table('projects').toArray()) as (Project & { files?: Attachment[] })[]
    const items: BrainItem[] = []
    for (const p of projects) {
      for (const f of p.files ?? []) {
        if (f.kind !== 'text' || !f.text) continue
        items.push({
          id: crypto.randomUUID(),
          kind: 'file',
          title: f.name,
          content: f.text,
          tags: [],
          projectIds: [p.id],
          file: { name: f.name, mimeType: f.mimeType, size: f.size },
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })
      }
    }
    await tx.table('brain').bulkAdd(items)
    await tx.table('projects').toCollection().modify((p: { files?: unknown }) => {
      delete p.files
    })
  })

// Version 4 : rangement automatique du cerveau. « brainVersions » garde une copie de chaque élément
// AVANT qu'il soit réécrit (rien n'est jamais perdu, on peut restaurer), « tidyRuns » le résumé de
// chaque rangement. Les éléments existants ne changent pas : ils n'ont juste pas encore de dossier.
db.version(4).stores({
  conversations: 'id, updatedAt, projectId',
  projects: 'id, updatedAt',
  brain: 'id, updatedAt, kind, *projectIds, *tags',
  brainVersions: 'id, itemId, runId, savedAt',
  tidyRuns: 'id, at',
})

// Version 5 : synchro entre appareils (voir src/lib/sync.ts). « syncOutbox » = boîte d'envoi (une
// entrée par enregistrement modifié ou supprimé depuis le dernier envoi), « syncState » = curseur, etc.
db.version(5).stores({
  conversations: 'id, updatedAt, projectId',
  projects: 'id, updatedAt',
  brain: 'id, updatedAt, kind, *projectIds, *tags',
  brainVersions: 'id, itemId, runId, savedAt',
  tidyRuns: 'id, at',
  syncOutbox: 'key',
  syncState: 'key',
})

// --- Synchro : chaque écriture est notée dans la boîte d'envoi -----------------------------
//
// Les hooks de Dexie voient TOUTES les écritures (put, bulkPut, modify, delete…), même celles faites
// ailleurs qu'ici. Les changements sont collectés pendant la transaction et notés dans la boîte d'envoi
// une fois la transaction réussie (une transaction ne peut écrire que dans les tables qu'elle a ouvertes).
// Les changements appliqués PAR la synchro (venus d'un autre appareil) portent la marque `__aeryRemote`
// et ne sont pas renvoyés, sinon deux appareils se renverraient la même chose à l'infini.

export const SYNC_TABLES = ['conversations', 'projects', 'brain', 'brainVersions', 'tidyRuns'] as const
export type SyncTable = (typeof SYNC_TABLES)[number]

export interface SyncOutboxEntry {
  key: string // « table:id »
  table: SyncTable
  id: string
  at: number // moment de la modification
  deleted: boolean
}

type MarkedTransaction = Transaction & { __aeryRemote?: boolean; __aeryChanges?: Map<string, SyncOutboxEntry> }

const localChangeListeners = new Set<() => void>()
/** Prévient (ex. le moteur de synchro) quand des changements locaux attendent d'être envoyés. */
export function onLocalChange(listener: () => void): () => void {
  localChangeListeners.add(listener)
  return () => localChangeListeners.delete(listener)
}

function markChange(tx: Transaction, table: SyncTable, id: unknown, deleted: boolean): void {
  const t = tx as MarkedTransaction
  if (t.__aeryRemote || typeof id !== 'string') return
  if (!t.__aeryChanges) {
    const changes = new Map<string, SyncOutboxEntry>()
    t.__aeryChanges = changes
    t.on('complete', () => {
      db.syncOutbox
        .bulkPut([...changes.values()])
        .then(() => localChangeListeners.forEach((l) => l()))
        .catch(() => {
          // Boîte d'envoi inaccessible : rattrapé au prochain « tout renvoyer » (nouvelle base serveur).
        })
    })
  }
  t.__aeryChanges.set(`${table}:${id}`, { key: `${table}:${id}`, table, id, at: Date.now(), deleted })
}

for (const name of SYNC_TABLES) {
  const table = db.table(name)
  table.hook('creating', function (primKey, obj, tx) {
    markChange(tx, name, primKey ?? (obj as { id?: unknown }).id, false)
  })
  table.hook('updating', function (_mods, primKey, _obj, tx) {
    markChange(tx, name, primKey, false)
  })
  table.hook('deleting', function (primKey, _obj, tx) {
    markChange(tx, name, primKey, true)
  })
}

/** Nettoie une conversation lue depuis la base (ou reçue d'un autre appareil). */
export function normalizeConversation(c: Conversation): Conversation {
  return {
    ...c,
    titleSource: c.titleSource ?? 'auto',
    // Une réponse vide = l'appli a été fermée avant le premier mot : on la retire.
    // (sauf si l'agent avait déjà fait des étapes : on les garde)
    messages: c.messages.filter((m) => m.role !== 'assistant' || m.content !== '' || (m.steps?.length ?? 0) > 0),
  }
}

export async function loadConversations(): Promise<Conversation[]> {
  const all = await db.conversations.orderBy('updatedAt').reverse().toArray()
  return all.map(normalizeConversation)
}

export function saveConversation(conversation: Conversation): Promise<string> {
  return db.conversations.put(conversation)
}

export function deleteConversationFromDb(id: string): Promise<void> {
  return db.conversations.delete(id)
}

export function loadProjects(): Promise<Project[]> {
  return db.projects.orderBy('updatedAt').reverse().toArray()
}

export function saveProject(project: Project): Promise<string> {
  return db.projects.put(project)
}

/**
 * Supprime le projet. Ses conversations ne sont pas supprimées : elles repassent hors projet.
 * Ses fichiers de référence restent dans le cerveau (on les retire juste du projet).
 */
export async function deleteProjectFromDb(id: string): Promise<void> {
  await db.transaction('rw', db.projects, db.conversations, db.brain, async () => {
    await db.conversations.where('projectId').equals(id).modify((c) => {
      delete c.projectId
    })
    await db.brain.where('projectIds').equals(id).modify((i) => {
      i.projectIds = i.projectIds.filter((p) => p !== id)
    })
    await db.projects.delete(id)
  })
}

// --- Second cerveau -------------------------------------------------------------------

export function loadBrain(): Promise<BrainItem[]> {
  return db.brain.orderBy('updatedAt').reverse().toArray()
}

export function getBrainItem(id: string): Promise<BrainItem | undefined> {
  return db.brain.get(id)
}

export function saveBrainItems(items: BrainItem[]): Promise<string> {
  return db.brain.bulkPut(items)
}

export function deleteBrainItemFromDb(id: string): Promise<void> {
  return db.brain.delete(id)
}

// --- Historique des éléments et rangements ---------------------------------------------

/** Garde une copie des éléments avant de les modifier (rangement, restauration). */
export function saveBrainVersions(versions: BrainVersion[]): Promise<string> {
  return db.brainVersions.bulkPut(versions)
}

/** Versions d'un élément, de la plus récente à la plus ancienne. */
export async function loadBrainVersions(itemId: string): Promise<BrainVersion[]> {
  const all = await db.brainVersions.where('itemId').equals(itemId).sortBy('savedAt')
  return all.reverse()
}

export function loadRunVersions(runId: string): Promise<BrainVersion[]> {
  return db.brainVersions.where('runId').equals(runId).toArray()
}

/** Rangements, du plus récent au plus ancien. */
export function loadTidyRuns(limit = 30): Promise<TidyRun[]> {
  return db.tidyRuns.orderBy('at').reverse().limit(limit).toArray()
}

export function saveTidyRun(run: TidyRun): Promise<string> {
  return db.tidyRuns.put(run)
}

// --- Sauvegarde (export / import, voir src/lib/backup.ts) ---------------------------------

export interface BackupTables {
  conversations: Conversation[]
  projects: Project[]
  brain: BrainItem[]
  brainVersions: BrainVersion[]
  tidyRuns: TidyRun[]
}

/** Tout le contenu de la base, lu dans une seule transaction (photo cohérente). */
export function readAllTables(): Promise<BackupTables> {
  return db.transaction('r', [db.conversations, db.projects, db.brain, db.brainVersions, db.tidyRuns], async () => ({
    conversations: await db.conversations.toArray(),
    projects: await db.projects.toArray(),
    brain: await db.brain.toArray(),
    brainVersions: await db.brainVersions.toArray(),
    tidyRuns: await db.tidyRuns.toArray(),
  }))
}

export interface MergeCount {
  added: number
  updated: number
  kept: number
}

/**
 * Fusionne une sauvegarde dans la base, sans jamais rien supprimer :
 *  - un élément absent est ajouté ;
 *  - un élément présent n'est remplacé que si la sauvegarde en a une version PLUS RÉCENTE
 *    (`updatedAt`), sinon on garde celui d'ici ;
 *  - versions et rangements ne changent jamais une fois écrits : ajoutés seulement s'ils manquent.
 * Tout ou rien : si une écriture échoue, la base reste comme avant.
 */
export function mergeTables(incoming: BackupTables): Promise<Record<keyof BackupTables, MergeCount>> {
  return db.transaction('rw', [db.conversations, db.projects, db.brain, db.brainVersions, db.tidyRuns], async () => {
    async function merge<T extends { id: string }>(
      table: EntityTable<T, 'id'>,
      rows: T[],
      isNewer: (row: T, local: T) => boolean,
    ): Promise<MergeCount> {
      // Dexie a du mal avec un type générique « T » : on passe par une table « { id } » simple.
      const plain = table as unknown as EntityTable<{ id: string }, 'id'>
      const locals = (await plain.bulkGet(rows.map((r) => r.id))) as (T | undefined)[]
      const toWrite: T[] = []
      const count: MergeCount = { added: 0, updated: 0, kept: 0 }
      rows.forEach((row, i) => {
        const local = locals[i]
        if (!local) count.added++
        else if (isNewer(row, local)) count.updated++
        else return void count.kept++
        toWrite.push(row)
      })
      await plain.bulkPut(toWrite)
      return count
    }
    const newer = <T extends { updatedAt: number }>(row: T, local: T) => row.updatedAt > local.updatedAt
    const never = () => false
    return {
      conversations: await merge(db.conversations, incoming.conversations, newer),
      projects: await merge(db.projects, incoming.projects, newer),
      brain: await merge(db.brain, incoming.brain, newer),
      brainVersions: await merge(db.brainVersions, incoming.brainVersions, never),
      tidyRuns: await merge(db.tidyRuns, incoming.tidyRuns, never),
    }
  })
}

// --- Synchro : accès à la base pour src/lib/sync.ts --------------------------------------------

export interface SyncChange {
  table: SyncTable
  id: string
  at: number
  deleted: boolean
  data?: unknown
}

/** Ce que la synchro a changé ici : enregistrements remplacés et identifiants supprimés, par table. */
export type AppliedChanges = Partial<Record<SyncTable, { put: unknown[]; deleted: string[] }>>

const syncTable = (name: SyncTable) => db.table(name) as unknown as EntityTable<{ id: string }, 'id'>

export async function getSyncState<T>(key: string): Promise<T | undefined> {
  return (await db.syncState.get(key))?.value as T | undefined
}

export async function setSyncState(key: string, value: unknown): Promise<void> {
  await db.syncState.put({ key, value })
}

/** Les changements en attente d'envoi (les plus anciens d'abord). */
export async function readOutbox(): Promise<SyncOutboxEntry[]> {
  return (await db.syncOutbox.toArray()).sort((a, b) => a.at - b.at)
}

/** Enregistrements actuels (undefined = supprimé depuis). */
export function getSyncRecords(table: SyncTable, ids: string[]): Promise<({ id: string } | undefined)[]> {
  return syncTable(table).bulkGet(ids)
}

/**
 * Retire de la boîte d'envoi les entrées envoyées, sauf celles modifiées PENDANT l'envoi
 * (leur `at` a changé) : elles repartiront au prochain tour.
 */
export function clearSentOutbox(sent: SyncOutboxEntry[]): Promise<void> {
  return db.transaction('rw', db.syncOutbox, async () => {
    const current = await db.syncOutbox.bulkGet(sent.map((e) => e.key))
    const done = sent.filter((e, i) => current[i]?.at === e.at).map((e) => e.key)
    await db.syncOutbox.bulkDelete(done)
  })
}

/**
 * Met tout le contenu local dans la boîte d'envoi (premier branchement, ou base du serveur recréée).
 * Chaque enregistrement garde sa date de modification : entre deux appareils, le plus récent gagnera.
 */
export function enqueueEverything(): Promise<number> {
  return db.transaction('rw', [...SYNC_TABLES.map((t) => db.table(t)), db.syncOutbox], async () => {
    let count = 0
    for (const table of SYNC_TABLES) {
      const rows = (await db.table(table).toArray()) as { id: string; updatedAt?: number; savedAt?: number; at?: number }[]
      const keys = rows.map((r) => `${table}:${r.id}`)
      const existing = await db.syncOutbox.bulkGet(keys)
      const entries = rows
        .filter((_, i) => !existing[i])
        .map((r) => ({ key: `${table}:${r.id}`, table, id: r.id, at: r.updatedAt ?? r.savedAt ?? r.at ?? Date.now(), deleted: false }))
      await db.syncOutbox.bulkPut(entries)
      count += entries.length
    }
    return count
  })
}

/**
 * Applique les changements reçus du serveur (le plus récent gagne). Un enregistrement modifié ici
 * plus récemment (dans la boîte d'envoi) est gardé : c'est lui qui repartira vers le serveur.
 * Un enregistrement identique à ce qu'on a déjà (souvent : notre propre envoi qui revient) est ignoré.
 */
export function applyRemoteChanges(changes: SyncChange[]): Promise<AppliedChanges> {
  return db.transaction('rw', [...SYNC_TABLES.map((t) => db.table(t)), db.syncOutbox], async (tx) => {
    ;(tx as MarkedTransaction).__aeryRemote = true
    const applied: AppliedChanges = {}
    const note = (table: SyncTable) => (applied[table] ??= { put: [], deleted: [] })
    const pending = await db.syncOutbox.bulkGet(changes.map((c) => `${c.table}:${c.id}`))
    for (const [i, c] of changes.entries()) {
      if (!(SYNC_TABLES as readonly string[]).includes(c.table)) continue
      const local = pending[i]
      if (local && local.at > c.at) continue
      if (local) await db.syncOutbox.delete(local.key)
      const table = syncTable(c.table)
      const current = await table.get(c.id)
      if (c.deleted) {
        if (!current) continue
        await table.delete(c.id)
        note(c.table).deleted.push(c.id)
      } else {
        const data = c.data as { id?: unknown } | undefined
        if (!data || data.id !== c.id) continue
        if (current && JSON.stringify(current) === JSON.stringify(data)) continue
        await table.put(data as { id: string })
        note(c.table).put.push(data)
      }
    }
    return applied
  })
}
