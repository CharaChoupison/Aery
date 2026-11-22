import Dexie, { type EntityTable } from 'dexie'
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

export async function loadConversations(): Promise<Conversation[]> {
  const all = await db.conversations.orderBy('updatedAt').reverse().toArray()
  return all.map((c) => ({
    ...c,
    titleSource: c.titleSource ?? 'auto',
    // Une réponse vide = l'appli a été fermée avant le premier mot : on la retire.
    // (sauf si l'agent avait déjà fait des étapes : on les garde)
    messages: c.messages.filter((m) => m.role !== 'assistant' || m.content !== '' || (m.steps?.length ?? 0) > 0),
  }))
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
