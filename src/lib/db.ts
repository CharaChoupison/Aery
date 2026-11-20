import Dexie, { type EntityTable } from 'dexie'
import type { Conversation } from '@/hooks/useChat'
import type { Project } from '@/lib/projects'

/**
 * Base IndexedDB du chat (via Dexie).
 *
 * ⚠️ IndexedDB est liée à l'ORIGINE de la page (ex. http://localhost:5173) :
 * si le port change, le navigateur voit une autre base, vide. D'où strictPort dans vite.config.ts.
 */
const db = new Dexie('freellm-chat') as Dexie & {
  conversations: EntityTable<Conversation, 'id'>
  projects: EntityTable<Project, 'id'>
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

/** Supprime le projet. Ses conversations ne sont pas supprimées : elles repassent hors projet. */
export async function deleteProjectFromDb(id: string): Promise<void> {
  await db.transaction('rw', db.projects, db.conversations, async () => {
    await db.conversations.where('projectId').equals(id).modify((c) => {
      delete c.projectId
    })
    await db.projects.delete(id)
  })
}
