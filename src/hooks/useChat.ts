import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, chatCompletion, isAbortError, isRouterModel, sendsImages, streamChat, type ChatMessage } from '@/lib/api'
import { textWithFiles, type Attachment } from '@/lib/attachments'
import { deleteConversationFromDb, loadConversations, saveConversation } from '@/lib/db'
import { buildSystemPrompt, getPreferences, samplingParams } from '@/lib/preferences'

/** Message affiché : un ChatMessage + des infos propres à l'interface. */
export interface UiMessage extends ChatMessage {
  id: string
  stopped?: boolean // réponse interrompue par le bouton Stop
  model?: string // modèle qui a réellement répondu (utile avec « auto »)
  reasoning?: string // réflexion des modèles « à raisonnement », affichée à part
  note?: string // petite remarque sous la réponse (ex. modèle remplacé pour lire une image)
}

export interface Conversation {
  id: string
  title: string
  /** provisional = début du 1er message ; auto = résumé par le modèle ; user = renommé à la main */
  titleSource: 'provisional' | 'auto' | 'user'
  /** Modèle choisi pour cette conversation (absent = modèle par défaut). */
  model?: string
  messages: UiMessage[]
  createdAt: number
  updatedAt: number
}

export interface ChatError {
  message: string
  code?: string
  retryHistory: UiMessage[] // historique à renvoyer si on clique sur « Réessayer »
}

const newId = () => crypto.randomUUID()

/** Pendant le streaming, on enregistre au plus toutes les 2 s (pas à chaque mot). */
const STREAM_SAVE_INTERVAL = 2000

/** Titre provisoire : le début du premier message, en attendant le titre du modèle. */
function provisionalTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 40 ? `${oneLine.slice(0, 40)}…` : oneLine
}

const TITLE_PROMPT =
  'Tu génères des titres de conversation. Résume la demande de l’utilisateur en un titre de 5 mots maximum, ' +
  'dans la même langue que la demande. Réponds uniquement par le titre, sans guillemets, sans emoji et sans ponctuation finale.'

/** Nettoie la réponse du modèle : certains ajoutent « Titre : », des guillemets, du Markdown, des balises <think>… */
function cleanTitle(raw: string): string {
  const firstLine =
    raw
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  const title = firstLine
    .replace(/^(titre|title)\s*:\s*/i, '')
    .replace(/[*_`#>]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/^["'«“\s]+|["'»”\s.!?:;]+$/g, '')
    .trim()
  return title.length > 60 ? `${title.slice(0, 60).trimEnd()}…` : title
}

const DEFAULT_MODEL_KEY = 'freellm-chat:default-model'

// localStorage peut être indisponible (navigation privée stricte) : on ne plante jamais pour ça.
function readDefaultModel(): string {
  try {
    return localStorage.getItem(DEFAULT_MODEL_KEY) || 'auto'
  } catch {
    return 'auto'
  }
}

function writeDefaultModel(model: string): void {
  try {
    localStorage.setItem(DEFAULT_MODEL_KEY, model)
  } catch {
    // tant pis : le choix ne sera simplement pas retenu au prochain lancement
  }
}

/**
 * Tout l'état du chat : conversations, conversation ouverte, streaming en cours,
 * et la sauvegarde automatique dans IndexedDB.
 */
interface Options {
  onMissingKey?: () => void
  /** true / false si on sait si ce modèle lit les images, null si on ne sait pas. */
  isVisionModel?: (modelId: string) => boolean | null
}

/** Texte qui résume un message pour un titre : son contenu, sinon le nom des fichiers joints. */
function summaryText(m: Pick<ChatMessage, 'content' | 'attachments'>): string {
  return m.content.trim() || (m.attachments ?? []).map((a) => a.name).join(', ')
}

export function useChat(options: Options = {}) {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loaded, setLoaded] = useState(false)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null) // null = nouvelle conversation vide
  const [streamingId, setStreamingId] = useState<string | null>(null) // conversation en train de recevoir
  const [errors, setErrors] = useState<Record<string, ChatError>>({})
  // Modèle des nouvelles conversations = le dernier choisi (simple préférence, gardée dans localStorage).
  const [defaultModel, setDefaultModel] = useState(readDefaultModel)

  const abortRef = useRef<AbortController | null>(null)
  // Dernière version enregistrée de chaque conversation (comparée par référence).
  const savedRef = useRef(new Map<string, Conversation>())
  const lastStreamSaveRef = useRef(0)
  // Copie à jour des conversations, lisible depuis les fonctions asynchrones.
  const conversationsRef = useRef(conversations)
  useEffect(() => {
    conversationsRef.current = conversations
  })
  const titlePendingRef = useRef(new Set<string>()) // évite deux demandes de titre en parallèle

  // On garde la dernière version du callback dans une ref (mise à jour après chaque rendu).
  const onMissingKeyRef = useRef(options.onMissingKey)
  const isVisionRef = useRef(options.isVisionModel)
  useEffect(() => {
    onMissingKeyRef.current = options.onMissingKey
    isVisionRef.current = options.isVisionModel
  })

  // --- Chargement au démarrage ----------------------------------------------------
  useEffect(() => {
    loadConversations()
      .then((stored) => {
        for (const c of stored) savedRef.current.set(c.id, c)
        // Fusion : au cas où une conversation aurait été créée pendant le chargement.
        setConversations((prev) => [...prev, ...stored.filter((s) => !prev.some((p) => p.id === s.id))])
      })
      .catch(() => setStorageError('Impossible de lire l’historique (navigation privée ?).'))
      .finally(() => setLoaded(true))
    // Si l'appli se ferme pendant une réponse, on coupe la requête.
    return () => abortRef.current?.abort()
  }, [])

  // --- Sauvegarde automatique -----------------------------------------------------
  // Les objets React sont immuables : si la référence a changé, la conversation a changé.
  useEffect(() => {
    if (!loaded) return
    const now = Date.now()
    for (const c of conversations) {
      if (savedRef.current.get(c.id) === c) continue
      if (c.id === streamingId) {
        if (now - lastStreamSaveRef.current < STREAM_SAVE_INTERVAL) continue
        lastStreamSaveRef.current = now
      }
      savedRef.current.set(c.id, c)
      // Sauvegarde en cours de streaming : on marque la réponse « interrompue ». Si la page est
      // fermée maintenant, c'est ce qu'on verra au retour. La sauvegarde finale enlèvera la mention.
      const toSave =
        c.id === streamingId
          ? { ...c, messages: c.messages.map((m, i) => (i === c.messages.length - 1 ? { ...m, stopped: true } : m)) }
          : c
      saveConversation(toSave).catch(() => setStorageError('La sauvegarde de l’historique a échoué.'))
    }
  }, [conversations, streamingId, loaded])

  /** Modifie une conversation précise (même si l'utilisateur en a ouvert une autre entre-temps). */
  const updateConversation = useCallback((id: string, update: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? update(c) : c)))
  }, [])

  const setError = useCallback((id: string, error: ChatError | null) => {
    setErrors((prev) => {
      if (!error && !(id in prev)) return prev
      const next = { ...prev }
      if (error) next[id] = error
      else delete next[id]
      return next
    })
  }, [])

  /** Demande au modèle un titre court. En cas d'échec, on garde simplement le titre provisoire. */
  const generateTitle = useCallback(
    async (convId: string, firstMessage: string) => {
      if (titlePendingRef.current.has(convId)) return
      titlePendingRef.current.add(convId)
      try {
        const { content } = await chatCompletion([
          { role: 'system', content: TITLE_PROMPT },
          { role: 'user', content: firstMessage.slice(0, 1000) },
        ])
        const title = cleanTitle(content)
        if (!title) return
        // Seulement si l'utilisateur ne l'a pas renommée entre-temps.
        updateConversation(convId, (c) => (c.titleSource === 'provisional' ? { ...c, title, titleSource: 'auto' } : c))
      } catch {
        // Pas grave : le titre provisoire reste (on réessaiera après la prochaine réponse).
      } finally {
        titlePendingRef.current.delete(convId)
      }
    },
    [updateConversation],
  )

  /** Lance une réponse en streaming dans la conversation `convId`, à partir de `history`. */
  const runStream = useCallback(
    async (convId: string, history: UiMessage[], model: string) => {
      const controller = new AbortController()
      abortRef.current = controller
      setStreamingId(convId)
      setError(convId, null)

      // Réglages lus au moment de l'envoi : un changement dans les Paramètres vaut dès la réponse suivante.
      const prefs = getPreferences()

      // Une image à lire, mais le modèle choisi n'est pas un modèle « vision » : on laisse le routeur
      // (auto) choisir un modèle qui sait lire les images, pour ce message seulement.
      let note: string | undefined
      if (!isRouterModel(model) && sendsImages(history, prefs.historyLimit) && isVisionRef.current?.(model) === false) {
        note = `« ${model} » ne lit pas les images : réponse confiée à Auto, qui a choisi un modèle vision.`
        model = 'auto'
      }

      const assistantId = newId()
      // Bulle vide pour l'assistant, remplie au fil du flux.
      updateConversation(convId, (c) => ({
        ...c,
        messages: [...history, { id: assistantId, role: 'assistant', content: '', note }],
        updatedAt: Date.now(),
      }))

      const setAssistant = (patch: Partial<UiMessage>) =>
        updateConversation(convId, (c) => ({
          ...c,
          messages: c.messages.map((m) => (m.id === assistantId ? { ...m, ...patch } : m)),
        }))
      const removeAssistant = () => updateConversation(convId, (c) => ({ ...c, messages: history }))

      let received = ''
      let reasoning = ''
      try {
        const stream = streamChat(history, {
          model,
          signal: controller.signal,
          systemPrompt: buildSystemPrompt(prefs),
          sampling: samplingParams(prefs),
          historyLimit: prefs.historyLimit,
        })
        for await (const event of stream) {
          if (event.type === 'model') {
            setAssistant({ model: event.model })
          } else if (event.type === 'reasoning') {
            reasoning += event.text
            setAssistant({ reasoning })
          } else {
            received += event.text
            setAssistant({ content: received })
          }
        }
        if (!received) {
          throw new ApiError(
            502,
            reasoning
              ? 'Le modèle a réfléchi mais n’a pas écrit de réponse. Réessaie ou choisis un autre modèle.'
              : 'Le modèle a renvoyé une réponse vide. Réessaie.',
          )
        }
        // Réponse réussie et titre encore provisoire : on demande un vrai titre (en parallèle, sans bloquer).
        const conv = conversationsRef.current.find((c) => c.id === convId)
        const firstUser = history.find((m) => m.role === 'user')
        if (conv?.titleSource === 'provisional' && firstUser && getPreferences().autoTitle) {
          // Le titre se base sur le texte (et le début des fichiers texte), pas sur les images.
          void generateTitle(convId, textWithFiles(firstUser.content, firstUser.attachments) || summaryText(firstUser))
        }
      } catch (e) {
        if (isAbortError(e)) {
          // Stop : on garde ce qui a été reçu. Si rien n'est arrivé, on retire la bulle vide.
          if (received) setAssistant({ stopped: true })
          else removeAssistant()
        } else {
          if (!received) removeAssistant()
          const apiError = e instanceof ApiError ? e : null
          if (apiError?.code === 'no_key') onMissingKeyRef.current?.()
          setError(convId, {
            message: apiError?.message ?? 'Une erreur inattendue est survenue.',
            code: apiError?.code,
            retryHistory: history,
          })
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null
        setStreamingId(null)
      }
    },
    [generateTitle, setError, updateConversation],
  )

  const send = useCallback(
    (text: string, attachments: Attachment[] = []) => {
      const content = text.trim()
      if ((!content && attachments.length === 0) || streamingId) return

      const userMessage: UiMessage = {
        id: newId(),
        role: 'user',
        content,
        ...(attachments.length > 0 && { attachments }),
      }
      const existing = conversations.find((c) => c.id === activeId)

      if (existing) {
        void runStream(existing.id, [...existing.messages, userMessage], existing.model ?? defaultModel)
        return
      }

      // Première question : on crée la conversation.
      const now = Date.now()
      const conv: Conversation = {
        id: newId(),
        title: provisionalTitle(summaryText(userMessage)),
        titleSource: 'provisional',
        model: defaultModel,
        messages: [],
        createdAt: now,
        updatedAt: now,
      }
      setConversations((prev) => [conv, ...prev])
      setActiveId(conv.id)
      void runStream(conv.id, [userMessage], defaultModel)
    },
    [activeId, conversations, defaultModel, runStream, streamingId],
  )

  const stop = useCallback(() => abortRef.current?.abort(), [])

  const retry = useCallback(() => {
    if (!activeId || streamingId) return
    const error = errors[activeId]
    const conv = conversations.find((c) => c.id === activeId)
    if (error) void runStream(activeId, error.retryHistory, conv?.model ?? defaultModel)
  }, [activeId, conversations, defaultModel, errors, runStream, streamingId])

  /** Choisir un modèle : il s'applique à la conversation ouverte ET devient le défaut des nouvelles. */
  const setModel = useCallback(
    (model: string) => {
      setDefaultModel(model)
      writeDefaultModel(model)
      if (activeId) updateConversation(activeId, (c) => ({ ...c, model }))
    },
    [activeId, updateConversation],
  )

  const newConversation = useCallback(() => setActiveId(null), [])
  const selectConversation = useCallback((id: string) => setActiveId(id), [])

  const renameConversation = useCallback(
    (id: string, title: string) => {
      const clean = title.replace(/\s+/g, ' ').trim().slice(0, 100)
      if (!clean) return
      // updatedAt inchangé : renommer ne fait pas remonter la conversation dans la liste.
      updateConversation(id, (c) => ({ ...c, title: clean, titleSource: 'user' }))
    },
    [updateConversation],
  )

  const deleteConversation = useCallback(
    (id: string) => {
      if (streamingId === id) abortRef.current?.abort()
      setConversations((prev) => prev.filter((c) => c.id !== id))
      setActiveId((current) => (current === id ? null : current))
      setError(id, null)
      savedRef.current.delete(id)
      deleteConversationFromDb(id).catch(() => setStorageError('La suppression dans l’historique a échoué.'))
    },
    [setError, streamingId],
  )

  const active = conversations.find((c) => c.id === activeId) ?? null

  return {
    conversations: [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    loaded,
    storageError,
    active,
    activeError: activeId ? (errors[activeId] ?? null) : null,
    streamingId,
    isStreaming: streamingId !== null,
    selectedModel: active?.model ?? defaultModel,
    setModel,
    send,
    stop,
    retry,
    newConversation,
    selectConversation,
    renameConversation,
    deleteConversation,
  }
}
