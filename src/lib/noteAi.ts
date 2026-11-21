import type { ChatMessage } from './api'
import { splitThinking } from './thinking'

/**
 * Barre « Demande à l'IA » d'une note du cerveau : le modèle écrit du Markdown que l'on
 * montre d'abord en aperçu. Rien ne touche la note tant que l'utilisateur n'a pas choisi
 * « Insérer » ou « Remplacer ».
 */

/** Au-delà, on coupe la note envoyée (les modèles gratuits ont souvent une petite fenêtre de contexte). */
const MAX_NOTE_CHARS = 24_000

export interface NoteAiTarget {
  title: string
  content: string
  /** Passage sélectionné dans la note : la demande porte dessus. */
  selection?: string
}

const SYSTEM = `Tu aides à écrire dans une note Markdown d'un « second cerveau » (notes personnelles, façon Notion / Obsidian).
Réponds UNIQUEMENT avec le texte Markdown à mettre dans la note : pas de phrase d'introduction ni de conclusion (« Voici… », « J'espère que… »), pas de bloc \`\`\` autour de toute la réponse.
- Si un passage est sélectionné, renvoie seulement le nouveau texte pour ce passage.
- Si la demande transforme toute la note (corriger, reformuler, traduire, réorganiser…), renvoie la note entière modifiée.
- Sinon (écrire, compléter, ajouter une section…), renvoie seulement le nouveau texte, qui sera ajouté à la note.
Écris dans la langue de la note (en français si elle est vide). Garde les liens [[…]] tels quels. N'invente pas de faits précis (chiffres, dates, citations) que tu ne connais pas.`

export function buildNoteAiMessages(target: NoteAiTarget, request: string): ChatMessage[] {
  const note = target.content.length > MAX_NOTE_CHARS ? `${target.content.slice(0, MAX_NOTE_CHARS)}\n[… note coupée …]` : target.content
  const parts = [`Titre de la note : ${target.title.trim() || 'Sans titre'}`, note.trim() ? `Note actuelle :\n<note>\n${note}\n</note>` : 'La note est vide.']
  if (target.selection) parts.push(`Passage sélectionné :\n<selection>\n${target.selection}\n</selection>`)
  parts.push(`Demande : ${request.trim()}`)
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: parts.join('\n\n') },
  ]
}

/** Nettoie la réponse : réflexion <think>, bloc ```markdown autour de tout, phrase d'intro « Voici… : ». */
export function cleanNoteAiOutput(raw: string): string {
  let text = splitThinking(raw).answer.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text)
  if (fenced) text = fenced[1].trim()
  text = text.replace(/^(?:voici|bien sûr|d'accord|ok)\b[^\n]{0,120}:\s*\n+/i, '')
  return text
}

/** Place `text` dans `content` entre `start` et `end`, avec des lignes vides autour si c'est un nouveau bloc. */
export function spliceNote(content: string, start: number, end: number, text: string): { content: string; caret: number } {
  const before = content.slice(0, start)
  const after = content.slice(end)
  // Remplacement d'une sélection : on garde ses espaces et retours à la ligne de début et de fin
  // (un triple-clic sélectionne aussi le « \n » final, que le modèle ne renvoie pas).
  // Insertion : on sépare en paragraphes.
  const insert = start === end
  if (!insert) {
    const selected = content.slice(start, end)
    text = (/^\s*/.exec(selected)?.[0] ?? '') + text.trim() + (/\s*$/.exec(selected)?.[0] ?? '')
  }
  const lead = insert && before.trim() ? (before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n') : ''
  const trail = insert && after.trim() ? (after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n') : ''
  const next = before + lead + text + trail + after
  return { content: next, caret: before.length + lead.length + text.length }
}
