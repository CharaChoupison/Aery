import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '@/lib/api'

interface State<T> {
  key: string
  data?: T
  error?: string
}

/**
 * Charge une donnée de FreeLLMAPI et la recharge quand `deps` change (ex. la période).
 *  - Pendant un rechargement, l'ancienne donnée reste affichée (pas de clignotement).
 *  - La requête précédente est annulée si on change d'avis avant la réponse.
 *  - reload() pour rafraîchir à la main (ou toutes les N secondes pour les journaux).
 */
export function useAdminData<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [nonce, setNonce] = useState(0)
  const key = `${JSON.stringify(deps)}#${nonce}`
  const [state, setState] = useState<State<T>>({ key: '' })

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then(
      (data) => setState({ key, data }),
      (e) => {
        if (controller.signal.aborted) return
        const message = e instanceof ApiError ? e.message : 'Impossible de charger les données.'
        setState((prev) => ({ key, data: prev.data, error: message }))
      },
    )
    return () => controller.abort()
    // `load` change à chaque rendu : c'est `key` (les dépendances) qui décide du rechargement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data: state.data, error: state.error, loading: state.key !== key, reload }
}
