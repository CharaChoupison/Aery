import { useCallback, useEffect, useState } from 'react'
import { getChain } from '@/lib/admin'
import { isRouterModel } from '@/lib/api'

interface Capabilities {
  vision: Set<string>
  tools: Set<string>
}

/**
 * Que sait faire chaque modèle : lire les images ? appeler des outils (recherche web, agent) ?
 * /v1/models ne le dit pas, mais la chaîne de FreeLLMAPI (API d'admin) a les champs supportsVision
 * et supportsTools. Si on ne peut pas la lire (FreeLLMAPI lancé en serveur, sans l'appli desktop),
 * on répond null = « on ne sait pas » et on laisse faire le routeur.
 */
export function useModelCapabilities(enabled: boolean, version: number) {
  const [caps, setCaps] = useState<Capabilities | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    getChain(controller.signal).then(
      (chain) => {
        const next: Capabilities = { vision: new Set(), tools: new Set() }
        for (const m of chain) {
          // /v1/models expose soit l'identifiant du modèle, soit celui de son groupe : on garde les deux.
          const ids = [m.modelId, m.canonicalId].filter((id): id is string => Boolean(id))
          for (const id of ids) {
            if (m.supportsVision) next.vision.add(id)
            if (m.supportsTools) next.tools.add(id)
          }
        }
        setCaps(next)
      },
      () => {
        if (!controller.signal.aborted) setCaps(null)
      },
    )
    return () => controller.abort()
  }, [enabled, version])

  // true / false si on sait, null sinon. Le routeur (auto, fusion, auto:…) choisit lui-même.
  const isVisionModel = useCallback(
    (modelId: string): boolean | null => (isRouterModel(modelId) ? true : caps ? caps.vision.has(modelId) : null),
    [caps],
  )
  const isToolModel = useCallback(
    (modelId: string): boolean | null => (isRouterModel(modelId) ? true : caps ? caps.tools.has(modelId) : null),
    [caps],
  )
  return { isVisionModel, isToolModel }
}
