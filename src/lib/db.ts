import Dexie, { type EntityTable } from 'dexie'
import type { Conversation } from '@/hooks/useChat'
import type { Project } from '@/lib/projects'
import type { BrainItem } from '@/lib/brain'
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
