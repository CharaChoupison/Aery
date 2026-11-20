import { useCallback, useEffect, useRef, useState } from 'react'
import type { View } from '@/App'

/** Un « endroit » de l'appli : une page, et la conversation ouverte si c'est le chat. */
export interface Place {
  view: View
  /** null = nouvelle conversation vide. */
  conversationId: string | null
  /** Accueil d'un projet (seulement quand aucune conversation n'est ouverte). */
  projectId?: string | null
}

const MAX_ENTRIES = 50

function samePlace(a: Place, b: Place) {
  return a.view === b.view && a.conversationId === b.conversationId && (a.projectId ?? null) === (b.projectId ?? null)
}

/**
 * Historique Précédent / Suivant, comme un navigateur, mais pour les pages de l'appli.
 *
 * On ne pilote pas la navigation ici : on OBSERVE l'endroit courant. À chaque changement, on
 * l'ajoute à la pile (et on efface le « Suivant », comme un navigateur). Quand c'est nous qui
 * reculons/avançons, on ne réenregistre pas.
 */
export function useNavHistory(current: Place, go: (place: Place) => void, exists: (place: Place) => boolean) {
  const [state, setState] = useState<{ entries: Place[]; index: number }>({ entries: [current], index: 0 })
  const jumpingTo = useRef<Place | null>(null)

  useEffect(() => {
    setState(({ entries, index }) => {
      const here = entries[index]
      if (samePlace(here, current)) return { entries, index }
      // Changement provoqué par Précédent/Suivant : l'index est déjà à jour.
      if (jumpingTo.current && samePlace(jumpingTo.current, current)) {
        jumpingTo.current = null
        return { entries, index }
      }
      // Le 1er message d'une nouvelle conversation lui donne un id : c'est le même endroit, on remplace.
      if (here.view === 'chat' && current.view === 'chat' && here.conversationId === null) {
        const next = [...entries]
        next[index] = current
        return { entries: next, index }
      }
      const next = [...entries.slice(0, index + 1), current].slice(-MAX_ENTRIES)
      return { entries: next, index: next.length - 1 }
    })
  }, [current.view, current.conversationId, current.projectId])

  /** Index du prochain endroit encore valide dans une direction (une conversation supprimée est sautée). */
  const target = useCallback(
    (step: -1 | 1) => {
      for (let i = state.index + step; i >= 0 && i < state.entries.length; i += step) {
        if (exists(state.entries[i]) && !samePlace(state.entries[i], current)) return i
      }
      return null
    },
    [state, exists, current],
  )

  const move = useCallback(
    (step: -1 | 1) => {
      const i = target(step)
      if (i === null) return
      const place = state.entries[i]
      jumpingTo.current = place
      setState((s) => ({ ...s, index: i }))
      go(place)
    },
    [target, state.entries, go],
  )

  return {
    canGoBack: target(-1) !== null,
    canGoForward: target(1) !== null,
    back: useCallback(() => move(-1), [move]),
    forward: useCallback(() => move(1), [move]),
  }
}
