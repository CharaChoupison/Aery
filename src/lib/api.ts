// Le navigateur ne parle jamais directement à FreeLLMAPI et ne voit jamais la clé :
//  - version web : notre serveur Vite (/api/settings, /v1/*) — voir server/freellmPlugin.ts
//  - appli Tauri : la partie Rust (commandes get_settings, save_settings, proxy_request)
// transport.ts choisit automatiquement le bon chemin.

import { hasImages, toContent, type Attachment } from './attachments'
import { readSSE } from './sse'
import { splitThinking } from './thinking'
import { appFetch, invokeCommand, IS_TAURI } from './transport'

export type Role = 'system' | 'user' | 'assistant'

export interface ChatMessage {
  role: Role
  content: string
  /** Images et fichiers texte joints (messages de l'utilisateur). */
  attachments?: Attachment[]
}

export interface Settings {
  hasKey: boolean
  keyHint: string | null
  port: number
}

export class ApiError extends Error {
  status: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Transforme une réponse d'erreur en message compréhensible. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = ''
  let code: string | undefined
  try {
    const body = await res.json()
    message = body?.error?.message ?? ''
    code = body?.error?.code
  } catch {
    // corps vide ou pas du JSON
  }

  if (code === 'no_key' || code === 'forbidden_origin') return new ApiError(res.status, message, code)
  if (code === 'no_vision_model')
    return new ApiError(
      res.status,
      'Aucun modèle capable de lire les images n’est activé. Active-en un dans Paramètres › Modèles (filtre Vision).',
      code,
    )
  if (res.status === 401 || res.status === 403)
    message = 'Clé FreeLLMAPI refusée. Vérifie-la dans les Paramètres.'
  else if (res.status === 429)
    message = 'Limite de requêtes atteinte chez le fournisseur. Attends un peu et réessaie.'
  else if (res.status === 502 || res.status === 504)
    message ||= 'FreeLLMAPI ne répond pas. Vérifie que l’appli est lancée.'
  else if (res.status >= 500) message ||= `Erreur du fournisseur (${res.status}). Réessaie dans un instant.`

  return new ApiError(res.status, message || `Erreur ${res.status}`, code)
}

type FetchInit = Parameters<typeof appFetch>[1]

/** appFetch + erreurs lisibles. Laisse passer l'AbortError (bouton Stop) telle quelle. */
async function safeFetch(path: string, init?: FetchInit): Promise<Response> {
  let res: Response
  try {
    res = await appFetch(path, init)
  } catch (e) {
    if (isAbortError(e)) throw e
    throw new ApiError(
      0,
      IS_TAURI
        ? `Erreur interne de l’appli : ${(e as Error).message}`
        : 'Impossible de joindre le serveur local. Est-ce que `npm run dev` tourne ?',
    )
  }
  if (!res.ok) throw await toApiError(res)
  return res
}

async function request<T>(path: string, init?: FetchInit): Promise<T> {
  const res = await safeFetch(path, init)
  return res.json() as Promise<T>
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

// --- Réglages ---------------------------------------------------------------
// Appli : clé dans le Trousseau macOS (via Rust). Web : fichier ~/.freellm-chat (via le plugin Vite).

export async function getSettings(): Promise<Settings> {
  if (IS_TAURI) {
    try {
      return await invokeCommand<Settings>('get_settings')
    } catch (e) {
      throw new ApiError(500, (e as Error).message)
    }
  }
  const res = await fetch('/api/settings')
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

/** apiKey: string = nouvelle clé, null = supprimer, undefined = ne pas toucher */
export async function saveSettings(update: { apiKey?: string | null; port?: number }): Promise<Settings> {
  if (IS_TAURI) {
    try {
      return await invokeCommand<Settings>('save_settings', {
        update: { apiKey: update.apiKey ?? null, deleteKey: update.apiKey === null, port: update.port ?? null },
      })
    } catch (e) {
      throw new ApiError(400, (e as Error).message)
    }
  }
  const res = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  })
  if (!res.ok) throw await toApiError(res)
  return res.json()
}

// --- FreeLLMAPI ---------------------------------------------------------------

export interface ModelInfo {
  id: string
  name: string
  family: string // famille déduite de l'identifiant (Llama, Qwen…), pour grouper la liste
  contextWindow: number | null
}

interface RawModel {
  id: string
  name?: string
  context_window?: number | null
  available?: boolean
}

/** Entrées spéciales du routeur FreeLLMAPI : auto, fusion, et les chaînes nommées auto:<nom>. */
export function isRouterModel(id: string): boolean {
  return id === 'auto' || id === 'fusion' || id.startsWith('auto:')
}

// FreeLLMAPI met owned_by: "freellmapi" sur TOUS les modèles : on déduit la famille de l'identifiant.
const FAMILIES: [RegExp, string][] = [
  [/llama/i, 'Llama'],
  [/qwen/i, 'Qwen'],
  [/gemma/i, 'Gemma'],
  [/nemotron/i, 'Nemotron'],
  [/gpt-oss/i, 'GPT-OSS'],
  [/mistral|mixtral|ministral|devstral|codestral/i, 'Mistral'],
  [/deepseek/i, 'DeepSeek'],
  [/glm/i, 'GLM'],
  [/kimi/i, 'Kimi'],
  [/phi-?\d/i, 'Phi'],
]

function familyOf(id: string): string {
  if (isRouterModel(id)) return 'Routeur FreeLLMAPI'
  return FAMILIES.find(([re]) => re.test(id))?.[1] ?? 'Autres'
}

/**
 * Modèles utilisables MAINTENANT. Sans ?available=true, FreeLLMAPI renvoie tout son catalogue,
 * y compris les modèles sans clé configurée ou désactivés.
 */
export async function listModels(): Promise<ModelInfo[]> {
  const data = await request<{ data: RawModel[] }>('/v1/models?available=true')
  return data.data
    .filter((m) => m.available !== false)
    // Alias « claude-opus-4-5 »… : des « slots » redirigés vers un modèle gratuit, pour d'autres outils.
    .filter((m) => !m.id.startsWith('claude-'))
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      family: familyOf(m.id),
      contextWindow: m.context_window ?? null,
    }))
}

// --- Recherche web ---------------------------------------------------------------
// FreeLLMAPI regroupe aussi des moteurs de recherche (Tavily, Brave, Exa, Parallel…) derrière
// POST /v1/search, avec la même clé freellmapi- et le même système de repli que pour les modèles.

export interface SearchHit {
  title: string
  url: string
  /** Extrait de la page (quelques centaines de caractères). */
  content: string
}

export interface SearchResult {
  query: string
  results: SearchHit[]
  /** Moteur qui a répondu (ex. « tavily »). */
  provider?: string
}

export interface SearchEngine {
  id: string
  /** Fournisseur (= platform de la page Clés : « tavily », « exa »…). */
  provider: string
  name: string
  /** Au moins une clé utilisable. */
  available: boolean
}

/**
 * Moteurs de recherche ACTIFS dans le catalogue de FreeLLMAPI. Un fournisseur de recherche absent
 * de cette liste (pas encore au catalogue, ou éteint) n'utiliserait pas la clé qu'on lui ajoute.
 */
export async function listSearchEngines(signal?: AbortSignal): Promise<SearchEngine[]> {
  const data = await request<{ data?: SearchEngine[] }>('/v1/search/engines', { signal })
  return Array.isArray(data.data) ? data.data : []
}

/** Lance une recherche web. Lève une ApiError au message lisible si aucun moteur n'est prêt. */
export async function webSearch(
  query: string,
  { topic = 'general', signal }: { topic?: 'general' | 'news'; signal?: AbortSignal } = {},
): Promise<SearchResult> {
  try {
    const data = await request<{ query?: string; results?: unknown; provider?: string }>('/v1/search', {
      method: 'POST',
      body: JSON.stringify({ query, topic, max_results: 5 }),
      signal,
    })
    // On ne garde que des résultats bien formés (titre et URL http(s)).
    const results = (Array.isArray(data.results) ? data.results : [])
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .map((r) => ({
        title: typeof r.title === 'string' ? r.title.slice(0, 300) : '',
        url: typeof r.url === 'string' ? r.url : '',
        content: typeof r.content === 'string' ? r.content : '',
      }))
      .filter((r) => /^https?:\/\//i.test(r.url))
    return { query: data.query ?? query, results, provider: data.provider }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'no_search_keys') {
      throw new ApiError(
        e.status,
        'Aucun moteur de recherche n’est prêt dans FreeLLMAPI. Ajoute-en un dans Paramètres › Clés des fournisseurs (groupe « Recherche web » : Tavily, Exa…, ou Parallel sans clé).',
        e.code,
      )
    }
    if (e instanceof ApiError && e.status === 429) {
      throw new ApiError(429, 'Limite des moteurs de recherche atteinte. Réessaie plus tard.', e.code)
    }
    throw e
  }
}

/** Nombre de messages envoyés par défaut : les modèles gratuits ont souvent un petit contexte. */
export const MAX_HISTORY = 20

export interface CompletionResult {
  content: string
  model?: string
}

export interface ChatOptions {
  model?: string
  signal?: AbortSignal
  /** Ajouté en tête, en message « system » (comme le Playground de FreeLLMAPI). */
  systemPrompt?: string
  /** temperature / top_p / max_tokens : seulement ceux que l'utilisateur a activés. */
  sampling?: { temperature?: number; top_p?: number; max_tokens?: number }
  /** Nombre de messages récents envoyés (défaut : MAX_HISTORY). */
  historyLimit?: number
  /** Outils que le modèle peut appeler (mode Agent). */
  tools?: ToolDefinition[]
  /** « none » = le modèle doit répondre en texte (dernière étape de l'agent). */
  toolChoice?: 'auto' | 'none'
  /** Messages bruts ajoutés après l'historique : les tours d'outils de l'agent. */
  extraMessages?: RawMessage[]
}

/** Un outil au format OpenAI : nom, description et paramètres (JSON Schema). */
export interface ToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** Un appel d'outil demandé par le modèle. `arguments` est du JSON… en texte (parfois invalide). */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** Message au format OpenAI, tel qu'envoyé (pour les tours d'outils). */
export type RawMessage =
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/** Les images ne sont envoyées que pour les N derniers messages qui en ont (sinon la requête devient énorme). */
const IMAGE_MESSAGES_SENT = 2

/** Messages réellement envoyés au modèle (les plus récents). */
export function sentHistory<T extends ChatMessage>(messages: T[], historyLimit = MAX_HISTORY): T[] {
  return messages.slice(-historyLimit)
}

/** true si la requête contiendra au moins une image (il faudra un modèle « vision »). */
export function sendsImages(messages: ChatMessage[], historyLimit?: number): boolean {
  return sentHistory(messages, historyLimit).some((m) => m.role === 'user' && hasImages(m.attachments))
}

/** Corps de requête commun. On ne garde que role + content (pas les champs propres à l'UI). */
function completionBody(messages: ChatMessage[], options: ChatOptions, stream: boolean): string {
  const recent = sentHistory(messages, options.historyLimit)
  const withImages = recent.flatMap((m, i) => (m.role === 'user' && hasImages(m.attachments) ? [i] : []))
  const keepImages = new Set(withImages.slice(-IMAGE_MESSAGES_SENT))
  const history = recent.map(({ role, content, attachments }, i) => ({
    role,
    // La réflexion <think>…</think> d'une ancienne réponse ne sert à rien au modèle : on économise le contexte.
    content:
      role === 'assistant' ? splitThinking(content).answer || content : toContent(content, attachments, keepImages.has(i)),
  }))
  const system = options.systemPrompt?.trim()
  return JSON.stringify({
    model: options.model ?? 'auto',
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...history, ...(options.extraMessages ?? [])],
    stream,
    ...options.sampling,
    ...(options.tools?.length && { tools: options.tools, tool_choice: options.toolChoice ?? 'auto' }),
  })
}

/** Requête simple, sans streaming (servira pour générer les titres de conversation). */
export async function chatCompletion(messages: ChatMessage[], options: ChatOptions = {}): Promise<CompletionResult> {
  const data = await request<{
    model?: string
    choices: { message: { content: string | null } }[]
  }>('/v1/chat/completions', {
    method: 'POST',
    body: completionBody(messages, options, false),
    signal: options.signal,
  })
  return { content: data.choices[0]?.message?.content ?? '', model: data.model }
}

/** Morceau d'appel d'outil en streaming : les arguments arrivent en plusieurs fois, repérés par `index`. */
interface ToolCallDelta {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChunk {
  model?: string
  choices?: {
    delta?: {
      content?: string | null
      reasoning?: string | null
      reasoning_content?: string | null
      tool_calls?: ToolCallDelta[] | null
    }
  }[]
  error?: { message?: string; code?: string }
}

/** Ce que renvoie le flux : du texte, de la réflexion, ou le nom du modèle qui répond vraiment. */
export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'model'; model: string }
  /** Fin de la réponse : les appels d'outils demandés (mode Agent), reconstitués en entier. */
  | { type: 'tool_calls'; calls: ToolCall[] }

/**
 * Recolle les morceaux d'appels d'outils. Certains fournisseurs envoient tout d'un coup,
 * d'autres les arguments caractère par caractère : dans les deux cas on concatène par `index`.
 */
class ToolCallAccumulator {
  private calls = new Map<number, ToolCall>()

  add(deltas: ToolCallDelta[]) {
    deltas.forEach((d, position) => {
      const index = d.index ?? position
      const call = this.calls.get(index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } }
      if (d.id) call.id = d.id
      if (d.function?.name) call.function.name = d.function.name // envoyé une seule fois (ou répété à l’identique)
      if (d.function?.arguments) call.function.arguments += d.function.arguments
      this.calls.set(index, call)
    })
  }

  /** Les appels complets, avec un identifiant même si le fournisseur n'en a pas donné. */
  result(): ToolCall[] {
    return [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ ...c, id: c.id || `call_${index}_${Date.now().toString(36)}` }))
      .filter((c) => c.function.name)
  }
}

/**
 * Streaming : renvoie les événements au fur et à mesure.
 *
 *   for await (const event of streamChat(messages, { signal })) {
 *     if (event.type === 'text') texte += event.text
 *   }
 *
 * Pour arrêter : controller.abort() → la boucle lève une AbortError.
 *
 * Délais : les fournisseurs gratuits sont parfois saturés et FreeLLMAPI peut rester muet
 * très longtemps. Sans réponse pendant 60 s (au début ou en cours de route), on abandonne
 * avec une ApiError « timeout » plutôt que de laisser l'utilisateur attendre indéfiniment.
 */
const RESPONSE_TIMEOUT = 60_000

export async function* streamChat(messages: ChatMessage[], options: ChatOptions = {}): AsyncGenerator<StreamEvent> {
  // Deux raisons d'annuler : le bouton Stop (options.signal) ou notre délai. AbortSignal.any les combine.
  const timeout = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const restartTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(() => timeout.abort(), RESPONSE_TIMEOUT)
  }
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal

  restartTimer()
  try {
    for await (const event of streamChatRaw(messages, { ...options, signal })) {
      restartTimer() // il se passe quelque chose : on repart pour 60 s
      yield event
    }
  } catch (e) {
    // C'est notre délai qui a coupé (et pas le bouton Stop) : message clair.
    if (timeout.signal.aborted && !options.signal?.aborted) {
      throw new ApiError(
        504,
        'Le modèle ne répond plus depuis 60 secondes (fournisseur saturé ?). Réessaie, ou choisis un autre modèle.',
        'timeout',
      )
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Le flux brut, sans gestion des délais. */
async function* streamChatRaw(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamEvent> {
  const res = await safeFetch('/v1/chat/completions', {
    method: 'POST',
    body: completionBody(messages, options, true),
    signal: options.signal,
  })

  // En-tête ajouté par FreeLLMAPI : « fournisseur/modèle » réellement utilisé (ou « cache »).
  const routedVia = res.headers.get('x-routed-via')
  let lastModel = routedVia || null
  if (lastModel) yield { type: 'model', model: lastModel }

  // Sécurité : si le serveur ignore stream:true et renvoie du JSON classique, on s'adapte.
  if (res.headers.get('content-type')?.includes('application/json')) {
    const data = (await res.json()) as {
      model?: string
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
    }
    if (!routedVia && data.model) yield { type: 'model', model: data.model }
    const content = data.choices?.[0]?.message?.content
    if (content) yield { type: 'text', text: content }
    const calls = data.choices?.[0]?.message?.tool_calls
    if (calls?.length) {
      const acc = new ToolCallAccumulator()
      acc.add(calls.map((c, index) => ({ index, id: c.id, function: c.function })))
      yield { type: 'tool_calls', calls: acc.result() }
    }
    return
  }

  if (!res.body) throw new ApiError(502, 'Réponse vide de FreeLLMAPI.')

  const toolCalls = new ToolCallAccumulator()
  for await (const data of readSSE(res.body)) {
    if (data === '[DONE]') break

    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      continue // ligne illisible : on l'ignore plutôt que de tout casser
    }

    // Certains fournisseurs envoient l'erreur DANS le flux, après le statut 200.
    if (chunk.error) {
      throw new ApiError(502, chunk.error.message || 'Le fournisseur a renvoyé une erreur pendant la réponse.', chunk.error.code)
    }

    // Le routeur peut changer de modèle en cours de route (repli si le premier échoue) :
    // on signale chaque changement. Si l'en-tête « groq/llama-3 » décrit déjà ce modèle (« llama-3 »),
    // on garde l'en-tête, plus précis.
    if (chunk.model && chunk.model !== lastModel && !lastModel?.endsWith(`/${chunk.model}`)) {
      lastModel = chunk.model
      yield { type: 'model', model: chunk.model }
    }

    const delta = chunk.choices?.[0]?.delta
    // Modèles « à raisonnement » : ils réfléchissent d'abord dans un champ à part
    // (« reasoning » chez OpenRouter/Kilo, « reasoning_content » chez DeepSeek et d'autres).
    const thought = delta?.reasoning ?? delta?.reasoning_content
    if (thought) yield { type: 'reasoning', text: thought }
    if (delta?.content) yield { type: 'text', text: delta.content }
    if (delta?.tool_calls?.length) toolCalls.add(delta.tool_calls)
  }

  const calls = toolCalls.result()
  if (calls.length) yield { type: 'tool_calls', calls }
}
