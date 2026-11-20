import { useCallback, useEffect, useState } from 'react'
import { getChain } from '@/lib/admin'
import { isRouterModel } from '@/lib/api'

/**
 * Quels modèles savent lire les images ? /v1/models ne le dit pas, mais la chaîne de FreeLLMAPI
 * (API d'admin) a un champ supportsVision. Si on ne peut pas la lire (FreeLLMAPI lancé en serveur,
 * sans l'appli desktop), on répond null = « on ne sait pas » et on laisse faire le routeur.
 */
export function useVisionModels(enabled: boolean, version: number) {
  const [vision, setVision] = useState<Set<string> | null>(null)

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    getChain(controller.signal).then(
      (chain) => {
        const ids = new Set<string>()
        for (const m of chain) {
          if (!m.supportsVision) continue
          ids.add(m.modelId) // /v1/models expose soit l'identifiant du modèle…
          if (m.canonicalId) ids.add(m.canonicalId) // …soit celui de son groupe
        }
        setVision(ids)
      },
      () => {
        if (!controller.signal.aborted) setVision(null)
      },
    )
    return () => controller.abort()
  }, [enabled, version])

  /** true / false si on sait, null sinon. Le routeur (auto, fusion, auto:…) choisit lui-même. */
  return useCallback(
    (modelId: string): boolean | null => (isRouterModel(modelId) ? true : vision ? vision.has(modelId) : null),
    [vision],
  )
}
