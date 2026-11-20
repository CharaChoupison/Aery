import { useCallback, useEffect, useRef, useState } from 'react'
import { chatCompletion } from '@/lib/api'
import type { Attachment } from '@/lib/attachments'
import { deleteBrainItemFromDb, loadBrain, saveBrainItems } from '@/lib/db'
import {
  BRAIN_LIMITS,
  ENRICH_PROMPT,
  firstLine,
  itemAsAttachment,
  newBrainItem,
  parseEnrichment,
  projectItems,
  sanitizeItem,
  type BrainItem,
} from '@/lib/brain'
import { attachmentKey } from '@/lib/projectSources'
import { PROJECT_LIMITS } from '@/lib/projects'

/** Message d'erreur si `item` ne rentre pas dans les fichiers de référence du projet (null = OK). */
export function projectRoomError(items: BrainItem[], projectId: string, item: Pick<BrainItem, 'id' | 'content'> & { name: string }): string | null {
  const current = projectItems(items, projectId).filter((i) => i.id !== item.id)
  if (current.length >= PROJECT_LIMITS.files) return `${PROJECT_LIMITS.files} fichiers maximum par projet.`
  const used = current.reduce((n, i) => n + i.content.length, 0)
  if (used + item.content.length > PROJECT_LIMITS.filesChars) {
    return `« ${item.name} » ne rentre pas : les fichiers d’un projet sont limités à ${PROJECT_LIMITS.filesChars.toLocaleString('fr-FR')} caractères (ils sont envoyés à chaque message).`
  }
  return null
}

/**
 * Le second cerveau, gardé dans IndexedDB comme l'historique. Chaque changement est enregistré
 * tout de suite : les outils de l'agent (search_notes, read_note) lisent directement la base.
 */
export function useBrain() {
  const [items, setItems] = useState<BrainItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  })

  useEffect(() => {
    loadBrain()
      .then((stored) => setItems((prev) => [...prev, ...stored.filter((s) => !prev.some((p) => p.id === s.id))]))
      .catch(() => setError('Impossible de lire le cerveau.'))
      .finally(() => setLoaded(true))
  }, [])

  const persist = useCallback((changed: BrainItem[]) => {
    if (changed.length) saveBrainItems(changed).catch(() => setError('L’enregistrement dans le cerveau a échoué.'))
  }, [])

  /** Applique `update` à chaque élément ; ceux qui changent sont enregistrés. */
  const mutate = useCallback(
    (update: (item: BrainItem) => BrainItem) => {
      const changed: BrainItem[] = []
      const next = itemsRef.current.map((i) => {
        const n = update(i)
        if (n !== i) changed.push(n)
        return n
      })
      itemsRef.current = next
      setItems(next)
      persist(changed)
    },
    [persist],
  )

  const add = useCallback(
    (fresh: BrainItem[]) => {
      if (!fresh.length) return
      const next = [...fresh, ...itemsRef.current]
      itemsRef.current = next
      setItems(next)
      persist(fresh)
    },
    [persist],
  )

  const create = useCallback(
    (fields: Partial<BrainItem> & Pick<BrainItem, 'kind'>) => {
      const item = newBrainItem(fields)
      add([item])
      return item
    },
    [add],
  )

  const update = useCallback(
    (id: string, patch: Partial<Omit<BrainItem, 'id' | 'createdAt'>>) =>
      mutate((i) => (i.id === id ? sanitizeItem({ ...i, ...patch, updatedAt: Date.now() }) : i)),
    [mutate],
  )

  const remove = useCallback((id: string) => {
    const next = itemsRef.current.filter((i) => i.id !== id)
    itemsRef.current = next
    setItems(next)
    deleteBrainItemFromDb(id).catch(() => setError('La suppression dans le cerveau a échoué.'))
  }, [])

  /**
   * Titre et tags proposés par le modèle (une petite requête, comme le titre des conversations).
   * Seulement si l'utilisateur n'a rien changé entre-temps. En cas d'échec, on garde le provisoire.
   */
  const enrich = useCallback(
    async (id: string, text: string) => {
      try {
        const { content } = await chatCompletion([
          { role: 'system', content: ENRICH_PROMPT },
          { role: 'user', content: text.slice(0, 4000) },
        ])
        const result = parseEnrichment(content)
        if (!result) return
        const before = itemsRef.current.find((i) => i.id === id)
        if (!before || before.updatedAt !== before.createdAt) return // modifié à la main : on n'y touche pas
        mutate((i) =>
          i.id === id
            ? sanitizeItem({ ...i, title: result.title || i.title, tags: i.tags.length ? i.tags : result.tags })
            : i,
        )
      } catch {
        // pas grave : titre provisoire, pas de tags
      }
    },
    [mutate],
  )

  /** « Garder dans le cerveau » sous une réponse du chat. */
  const saveReply = useCallback(
    (reply: { conversationId: string; messageId: string; question: string; answer: string }) => {
      const existing = itemsRef.current.find((i) => i.origin?.messageId === reply.messageId)
      if (existing) return existing
      const item = create({
        kind: 'reply',
        title: firstLine(reply.question) || firstLine(reply.answer),
        content: reply.answer,
        origin: { conversationId: reply.conversationId, messageId: reply.messageId },
      })
      void enrich(item.id, `Question : ${reply.question.slice(0, 800)}\n\nRéponse : ${reply.answer}`)
      return item
    },
    [create, enrich],
  )

  /** Note rapide (/note, ou « Nouvelle note » avec du texte). */
  const quickNote = useCallback(
    (text: string) => {
      const item = create({ kind: 'note', title: firstLine(text), content: text })
      void enrich(item.id, text)
      return item
    },
    [create, enrich],
  )

  /** Un fichier texte (pièce jointe, import) : le même fichier n'est gardé qu'une fois. */
  const keepFile = useCallback(
    (file: Attachment, projectId?: string): { item?: BrainItem; error?: string } => {
      if (file.kind !== 'text' || !file.text) return { error: 'Seuls les fichiers texte peuvent aller dans le cerveau.' }
      if (file.text.length > BRAIN_LIMITS.importChars) return { error: `« ${file.name} » est trop long (${BRAIN_LIMITS.importChars.toLocaleString('fr-FR')} caractères maximum).` }
      const key = attachmentKey(file)
      const existing = itemsRef.current.find((i) => i.file && attachmentKey({ kind: 'text', ...i.file }) === key)
      if (projectId) {
        const room = projectRoomError(itemsRef.current, projectId, { id: existing?.id ?? '', content: file.text, name: file.name })
        if (room) return { error: room }
      }
      if (existing) {
        if (projectId && !existing.projectIds.includes(projectId)) update(existing.id, { projectIds: [...existing.projectIds, projectId] })
        return { item: existing }
      }
      return {
        item: create({
          kind: 'file',
          title: file.name,
          content: file.text,
          file: { name: file.name, mimeType: file.mimeType, size: file.size },
          projectIds: projectId ? [projectId] : [],
        }),
      }
    },
    [create, update],
  )

  /** Une page web trouvée par la recherche (onglet Capturé). */
  const keepLink = useCallback(
    (link: { url: string; title: string }) =>
      itemsRef.current.find((i) => i.url === link.url) ?? create({ kind: 'web', title: link.title, url: link.url }),
    [create],
  )

  /** Fichiers de référence d'un projet, vus comme des pièces jointes (fenêtre du projet). */
  const projectFiles = useCallback((projectId: string) => projectItems(items, projectId).map(itemAsAttachment), [items])

  /**
   * Enregistre la liste des fichiers d'un projet (fenêtre du projet) : un fichier déjà dans le
   * cerveau y est rangé, un nouveau est créé, un fichier retiré quitte le projet mais reste dans le cerveau.
   */
  const setProjectFiles = useCallback(
    (projectId: string, files: Attachment[]) => {
      const ids = new Set(files.map((f) => f.id))
      mutate((i) => {
        const has = i.projectIds.includes(projectId)
        if (ids.has(i.id) && !has) return { ...i, projectIds: [...i.projectIds, projectId], updatedAt: Date.now() }
        if (!ids.has(i.id) && has) return { ...i, projectIds: i.projectIds.filter((p) => p !== projectId), updatedAt: Date.now() }
        return i
      })
      const known = new Set(itemsRef.current.map((i) => i.id))
      for (const f of files) if (!known.has(f.id)) keepFile(f, projectId)
    },
    [keepFile, mutate],
  )

  /** Projet supprimé : ses éléments restent dans le cerveau (la base est déjà à jour). */
  const detachProject = useCallback((projectId: string) => {
    const next = itemsRef.current.map((i) => (i.projectIds.includes(projectId) ? { ...i, projectIds: i.projectIds.filter((p) => p !== projectId) } : i))
    itemsRef.current = next
    setItems(next)
  }, [])

  return {
    items,
    loaded,
    error,
    create,
    update,
    remove,
    saveReply,
    quickNote,
    keepFile,
    keepLink,
    projectFiles,
    setProjectFiles,
    detachProject,
    getItem: useCallback((id: string) => items.find((i) => i.id === id), [items]),
  }
}

export type Brain = ReturnType<typeof useBrain>
