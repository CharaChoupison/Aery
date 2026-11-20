import type { Attachment } from './attachments'

/**
 * Projets : des dossiers de conversations qui partagent un contexte.
 *
 * Ce qui est envoyé au modèle, dans le message « system », pour chaque conversation du projet :
 *  - les instructions du projet ;
 *  - ses fichiers de référence (texte) ;
 *  - la « mémoire » : un court résumé de chacune des AUTRES conversations du projet,
 *    pour qu'il sache de quoi on a déjà parlé. Ces résumés sont demandés au modèle
 *    (une requête de plus de temps en temps, comme le titre automatique).
 */
export interface Project {
  id: string
  name: string
  instructions: string
  /** Fichiers texte de référence (pas d'images : elles ne passent pas dans le message système). */
  files: Attachment[]
  /** Résumer les conversations et s'en servir dans les autres. */
  memory: boolean
  createdAt: number
  updatedAt: number
}

/** Le résumé d'une conversation, gardé avec elle. */
export interface ConversationSummary {
  text: string
  /** Nombre de messages au moment du résumé : on le refait quand la conversation a bien avancé. */
  messageCount: number
}

export const PROJECT_LIMITS = {
  name: 60,
  instructions: 8_000,
  /** Total des fichiers : les modèles gratuits ont souvent une petite fenêtre de contexte. */
  filesChars: 60_000,
  files: 10,
  /** Résumés des autres conversations envoyés (les plus récentes). */
  summaries: 12,
} as const

/** On (re)résume une conversation tous les N messages (question + réponse = 2). */
export const SUMMARY_EVERY = 4

export const SUMMARY_PROMPT =
  'Tu aides à garder la mémoire d’un projet. Résume la conversation ci-dessous en 3 phrases maximum : ' +
  'le sujet, les décisions prises, les faits et préférences importants à retenir pour la suite. ' +
  'Écris dans la langue de la conversation, sans introduction ni Markdown.'

export function newProject(name: string): Project {
  const now = Date.now()
  return { id: crypto.randomUUID(), name: name.trim().slice(0, PROJECT_LIMITS.name) || 'Nouveau projet', instructions: '', files: [], memory: true, createdAt: now, updatedAt: now }
}

export const filesChars = (files: Attachment[]) => files.reduce((n, f) => n + (f.text?.length ?? 0), 0)

/** La partie « projet » du message système. Vide si le projet n'a rien à dire. */
export function buildProjectPrompt(
  project: Project,
  others: { title: string; summary: string }[],
): string {
  const parts = [`# Projet « ${project.name} »\nCette conversation fait partie du projet « ${project.name} ».`]
  if (project.instructions.trim()) parts.push(`## Instructions du projet\n${project.instructions.trim()}`)
  if (project.files.length) {
    const files = project.files.map((f) => `<fichier nom="${f.name.replace(/["<>]/g, '')}">\n${f.text ?? ''}\n</fichier>`)
    parts.push(`## Fichiers de référence du projet\n${files.join('\n\n')}`)
  }
  if (project.memory && others.length) {
    const lines = others.map((o) => `- ${o.title} : ${o.summary}`)
    parts.push(
      `## Ce dont on a déjà parlé dans ce projet\nRésumés des autres conversations du projet, à utiliser si c’est utile :\n${lines.join('\n')}`,
    )
  }
  return parts.join('\n\n')
}
