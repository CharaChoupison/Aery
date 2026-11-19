import Dexie, { type EntityTable } from 'dexie'
import type { Conversation } from '@/hooks/useChat'

/**
 * Base IndexedDB du chat (via Dexie).
 *
 * ⚠️ IndexedDB est liée à l'ORIGINE de la page (ex. http://localhost:5173) :
 * si le port change, le navigateur voit une autre base, vide. D'où strictPort dans vite.config.ts.
 */
const db = new Dexie('freellm-chat') as Dexie & {
  conversations: EntityTable<Conversation, 'id'>
}

// Version 1 du schéma : clé primaire « id », index sur « updatedAt » pour trier.
// Pour ajouter un champ indexé plus tard : db.version(2).stores({...}) — ne jamais modifier la version 1.
db.version(1).stores({
  conversations: 'id, updatedAt',
})

export async function loadConversations(): Promise<Conversation[]> {
  const all = await db.conversations.orderBy('updatedAt').reverse().toArray()
  return all.map((c) => ({
    ...c,
    titleSource: c.titleSource ?? 'auto',
    // Une réponse vide = l'appli a été fermée avant le premier mot : on la retire.
    messages: c.messages.filter((m) => m.role !== 'assistant' || m.content !== ''),
  }))
}

export function saveConversation(conversation: Conversation): Promise<string> {
  return db.conversations.put(conversation)
}

export function deleteConversationFromDb(id: string): Promise<void> {
  return db.conversations.delete(id)
}
