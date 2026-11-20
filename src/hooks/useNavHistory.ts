import { useCallback, useEffect, useRef, useState } from 'react'
import type { View } from '@/App'
import type { AppSpace } from '@/lib/projects'

/** Un « endroit » de l'appli : une page, et la conversation ouverte si c'est le chat. */
export interface Place {
  view: View
  /** null = nouvelle conversation vide. */
  conversationId: string | null
  /** Accueil d'un projet (seulement quand aucune conversation n'est ouverte). */
  projectId?: string | null
  /** Espace Chat, Code ou Cerveau (les accueils vides sont des endroits différents). */
  space: AppSpace
  /** Note du cerveau ouverte en pleine page. */
  noteId?: string | null
  /** Date de création de la conversation ouverte (pas comparée : sert à repérer une conversation neuve). */
  createdAt?: number
}

/** Une entrée de l'historique : l'endroit + le moment où on y est arrivé. */
type Entry = Place & { enteredAt: number }

const MAX_ENTRIES = 50

function samePlace(a: Place, b: Place) {
  return (
    a.view === b.view &&
    // Une conversation impose son espace (et peut en changer si on la déplace) : on ne compare
    // l'espace que pour les accueils vides.
    (a.conversationId !== null || a.space === b.space) &&
    a.conversationId === b.conversationId &&
    (a.projectId ?? null) === (b.projectId ?? null) &&
    (a.noteId ?? null) === (b.noteId ?? null)
  )
}

/**
 * Historique Précédent / Suivant, comme un navigateur, mais pour les pages de l'appli.
 *
 * On ne pilote pas la navigation ici : on OBSERVE l'endroit courant. À chaque changement, on
 * l'ajoute à la pile (et on efface le « Suivant », comme un navigateur). Quand c'est nous qui
 * reculons/avançons, on ne réenregistre pas.
 */
export function useNavHistory(current: Place, go: (place: Place) => void, exists: (place: Place) => boolean) {
  const [state, setState] = useState<{ entries: Entry[]; index: number }>(() => ({
    entries: [{ ...current, enteredAt: Date.now() }],
    index: 0,
  }))
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
      const entry = { ...current, enteredAt: Date.now() }
      // Le 1er message d'une nouvelle conversation lui donne un id : c'est le même endroit, on remplace.
      // (Seulement pour une conversation créée APRÈS l'arrivée sur l'accueil : ouvrir une ancienne
      // conversation depuis l'accueil, c'est un vrai changement d'endroit.)
      const createdHere =
        here.conversationId === null && current.conversationId !== null && (current.createdAt ?? 0) >= here.enteredAt
      if (here.view === 'chat' && current.view === 'chat' && createdHere) {
        const next = [...entries]
        next[index] = entry
        return { entries: next, index }
      }
      const next = [...entries.slice(0, index + 1), entry].slice(-MAX_ENTRIES)
      return { entries: next, index: next.length - 1 }
    })
  }, [current.view, current.conversationId, current.projectId, current.space, current.noteId])

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
