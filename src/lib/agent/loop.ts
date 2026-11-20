/**
 * La boucle d'agent.
 *
 *   1. On envoie la conversation + la liste des outils.
 *   2. Le modèle répond soit du texte (fini !), soit des appels d'outils (tool_calls).
 *   3. On exécute chaque outil, on ajoute son résultat (message « tool ») et on recommence.
 *
 * Garde-fou : au bout de MAX_ROUNDS tours, on demande au modèle de répondre sans outil.
 * Les tours d'outils ne sont pas gardés dans l'historique de la conversation (seulement affichés) :
 * au message suivant, le modèle ne reçoit que les réponses finales. Ça économise le contexte.
 */

import { ApiError, isAbortError, streamChat, type ChatMessage, type ChatOptions, type RawMessage, type ToolCall } from '@/lib/api'
import { agentTools, describeTool, executeTool, MAX_WEB_SEARCHES, type AgentSettings, type Source } from './tools'

export const MAX_ROUNDS = 12
/** Taille max d'un résultat d'outil renvoyé au modèle (les petits contextes saturent vite). */
const MAX_TOOL_RESULT = 12_000

/** Une étape affichée dans le chat : un texte intermédiaire, ou un appel d'outil. */
export type AgentStep =
  | { id: string; type: 'text'; text: string }
  | {
      id: string
      type: 'tool'
      tool: string
      /** Arguments bruts (JSON en texte), tels qu'envoyés par le modèle. */
      args: string
      label: string
      status: 'running' | 'done' | 'error'
      result?: string
      /** web_search : les pages trouvées (liens affichés sous l'étape). */
      sources?: Source[]
      durationMs?: number
    }

export type AgentEvent =
  | { type: 'model'; model: string }
  | { type: 'reasoning'; text: string }
  /** État complet après chaque changement (nouvelles étapes, texte qui arrive). */
  | { type: 'state'; steps: AgentStep[]; content: string }
  /** Limite de tours atteinte : la réponse finale a été forcée. */
  | { type: 'limit' }

function clip(text: string): string {
  return text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n… (résultat tronqué)` : text
}

export async function* runAgent(
  history: ChatMessage[],
  options: ChatOptions & { agent: AgentSettings; signal: AbortSignal },
): AsyncGenerator<AgentEvent> {
  const tools = agentTools(options.agent)
  const extra: RawMessage[] = [] // les tours d'outils de CE message
  const steps: AgentStep[] = []
  let webSearches = 0
  // Recherche web indisponible (limite des moteurs, aucun moteur prêt) : inutile de réessayer
  // pendant cette réponse, on renvoie directement l'erreur au modèle.
  let searchDown: string | null = null
  // Copie : React compare les références, chaque état envoyé doit être un nouvel objet.
  const snapshot = (content: string): AgentEvent => ({ type: 'state', steps: steps.map((s) => ({ ...s })), content })

  for (let round = 1; ; round++) {
    const last = round > MAX_ROUNDS
    let content = ''
    let calls: ToolCall[] = []

    const stream = streamChat(history, {
      ...options,
      tools,
      // Dernier tour : plus le droit aux outils, le modèle doit répondre avec ce qu'il a trouvé.
      toolChoice: last ? 'none' : 'auto',
      extraMessages: extra,
    })
    for await (const event of stream) {
      if (event.type === 'text') {
        content += event.text
        yield snapshot(content)
      } else if (event.type === 'tool_calls') {
        calls = event.calls
      } else {
        yield event
      }
    }

    if (calls.length === 0 || last) {
      if (last) yield { type: 'limit' }
      yield snapshot(content)
      return
    }

    // Le modèle a parlé avant d'appeler ses outils (« Je vais lire… ») : ce texte devient une étape.
    if (content.trim()) steps.push({ id: crypto.randomUUID(), type: 'text', text: content })
    extra.push({ role: 'assistant', content: content || null, tool_calls: calls })

    for (const call of calls) {
      const step: AgentStep & { type: 'tool' } = {
        id: crypto.randomUUID(),
        type: 'tool',
        tool: call.function.name,
        args: call.function.arguments,
        label: describeTool(call.function.name, call.function.arguments),
        status: 'running',
      }
      steps.push(step)
      yield snapshot('')

      const started = performance.now()
      let result: string
      try {
        const isWebSearch = call.function.name === 'web_search'
        if (isWebSearch && searchDown) throw new Error(searchDown)
        if (isWebSearch && ++webSearches > MAX_WEB_SEARCHES) {
          throw new Error(`Limite de ${MAX_WEB_SEARCHES} recherches atteinte pour cette réponse. Réponds avec ce que tu as déjà trouvé.`)
        }
        const output = await executeTool(call.function.name, call.function.arguments, options.agent, options.signal).catch(
          (e: unknown) => {
            if (isWebSearch && e instanceof ApiError && (e.status === 429 || e.code === 'no_search_keys')) {
              searchDown = `${e.message} Ne relance pas web_search : réponds avec ce que tu sais et précise que la recherche web n’a pas marché.`
              throw new Error(searchDown)
            }
            throw e
          },
        )
        result = output.text
        if (output.sources?.length) step.sources = output.sources
        step.status = 'done'
      } catch (e) {
        if (isAbortError(e)) {
          step.status = 'error'
          step.result = 'Annulé.'
          yield snapshot('')
          throw e
        }
        result = `Erreur : ${(e as Error).message}`
        step.status = 'error'
      }
      result = clip(result)
      step.result = result
      step.durationMs = Math.round(performance.now() - started)
      extra.push({ role: 'tool', tool_call_id: call.id, content: result })
      yield snapshot('')
    }
  }
}
