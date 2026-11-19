import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, listModels, type ModelInfo } from '@/lib/api'

/** Au-delà de ce délai, on recharge la liste à l'ouverture du sélecteur. */
const STALE_AFTER = 60_000

/** Liste des modèles disponibles dans FreeLLMAPI. */
export function useModels(enabled: boolean) {
  const [models, setModels] = useState<ModelInfo[]>([])
  const [loaded, setLoaded] = useState(false) // premier chargement terminé
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchedAtRef = useRef(0)
  const inFlightRef = useRef(false)

  /** Charge la liste. L'état n'est modifié qu'APRÈS la réponse (jamais de façon synchrone). */
  const load = useCallback(async () => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    try {
      const list = await listModels()
      setModels(list)
      setError(null)
      fetchedAtRef.current = Date.now()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Impossible de charger les modèles.')
    } finally {
      inFlightRef.current = false
      setLoaded(true)
    }
  }, [])

  /** Rechargement demandé par l'utilisateur (bouton) : avec indicateur de chargement. */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  /** Recharge seulement si la liste est vieille (appelé à l'ouverture du sélecteur). */
  const refreshIfStale = useCallback(() => {
    if (Date.now() - fetchedAtRef.current > STALE_AFTER) void refresh()
  }, [refresh])

  // Premier chargement dès qu'une clé est configurée.
  useEffect(() => {
    // Faux positif du linter : load() ne modifie l'état qu'après un await (réponse réseau),
    // jamais de façon synchrone. Charger des données distantes est bien le rôle d'un effet.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) void load()
  }, [enabled, load])

  return { models, loading: refreshing || (enabled && !loaded), error, refresh, refreshIfStale }
}
