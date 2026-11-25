import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cancelDictation,
  pickModel,
  refreshDictationModels,
  startDictation,
  stopDictation,
  useDictationModels,
  type DictationSource,
} from '@/lib/dictation'
import { getPreferences } from '@/lib/preferences'

export type Dictation = ReturnType<typeof useDictation>

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** Petit canal pour le niveau du son : l'animation l'écoute sans faire re-rendre tout le champ. */
export interface LevelSource {
  subscribe: (listener: (level: number) => void) => () => void
}

/**
 * Dictée dans un champ de texte : start() ouvre le micro, puis onText reçoit le texte dicté au fil
 * de l'eau (provisoire), et une dernière fois à la fin (stop). cancel() jette tout : onText('').
 * Chaque appel donne TOUT le texte dicté : le champ le remet à la place du précédent.
 * noModel = aucun modèle téléchargé (proposer les Paramètres).
 */
export function useDictation(onText: (text: string) => void) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [noModel, setNoModel] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [source, setSource] = useState<DictationSource>('mic')
  const { models } = useDictationModels()

  const [listeners] = useState(() => new Set<(level: number) => void>())
  const [levels] = useState<LevelSource>(() => ({
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }))
  // Copie de la phase lisible tout de suite (les fonctions asynchrones ne voient pas les re-rendus).
  const phaseRef = useRef<DictationPhase>('idle')
  const go = useCallback((next: DictationPhase) => {
    phaseRef.current = next
    setPhase(next)
  }, [])
  const sourceRef = useRef<DictationSource>('mic')
  const onTextRef = useRef(onText)
  useEffect(() => {
    onTextRef.current = onText
  })

  // Liste des modèles chargée une fois (pour savoir s'il y en a un de téléchargé).
  useEffect(() => {
    if (!models) void refreshDictationModels()
  }, [models])

  const stop = useCallback(async () => {
    if (phaseRef.current !== 'recording') return
    go('transcribing')
    try {
      const text = (await stopDictation()).trim()
      onTextRef.current(text)
      if (!text) {
        setError(
          sourceRef.current === 'system'
            ? 'Je n’ai rien entendu : aucune parole dans le son du Mac.'
            : 'Je n’ai rien entendu. Parle un peu plus près du micro et réessaie.',
        )
      }
    } catch (e) {
      setError(String(e))
    } finally {
      go('idle')
    }
  }, [go])

  /** source : 'mic' (dictée) ou 'system' (transcrire le son du Mac). */
  const start = useCallback(async (from: DictationSource = 'mic') => {
    if (phaseRef.current !== 'idle') return
    sourceRef.current = from
    setSource(from)
    setError(null)
    setNoModel(false)
    const list = models ?? (await refreshDictationModels())
    const model = pickModel(list, getPreferences().dictation.model)
    if (!model) {
      setNoModel(true)
      return
    }
    go('starting')
    try {
      await startDictation(model, getPreferences().dictation.language, from, {
        onLevel: (level) => listeners.forEach((l) => l(level)),
        // Un passage en direct peut arriver juste après la fin : on ne garde que ceux d'avant.
        onPartial: (text) => phaseRef.current === 'recording' && onTextRef.current(text),
        onLimit: () => void stop(), // durée maximale atteinte : on transcrit ce qu'on a
      })
      // Annulé pendant l'ouverture du micro : on le referme aussitôt.
      if ((phaseRef.current as DictationPhase) !== 'starting') return cancelDictation()
      setStartedAt(Date.now())
      go('recording')
    } catch (e) {
      setError(String(e))
      go('idle')
      void refreshDictationModels() // le modèle a peut-être été supprimé entre-temps
    }
  }, [models, stop, go, listeners])

  const cancel = useCallback(() => {
    if (phaseRef.current !== 'recording' && phaseRef.current !== 'starting') return
    // Pendant l'ouverture du micro, c'est start() qui le refermera (voir plus haut).
    if (phaseRef.current === 'recording') cancelDictation()
    go('idle')
    onTextRef.current('') // le texte provisoire disparaît
  }, [go])

  // Pendant l'enregistrement : Entrée = terminer, Échap = annuler (sauf si une fenêtre est ouverte).
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'starting') return
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter' && phase === 'recording') {
        e.preventDefault()
        void stop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, stop, cancel])

  // Le champ disparaît (changement de page) pendant l'enregistrement : on coupe le micro.
  useEffect(
    () => () => {
      if (phaseRef.current === 'recording') cancelDictation()
      phaseRef.current = 'idle' // pendant l'ouverture du micro, start() le refermera
    },
    [],
  )

  return {
    phase,
    /** Source de l'enregistrement en cours (ou du dernier). */
    source,
    error,
    noModel,
    startedAt,
    levels,
    start,
    stop,
    cancel,
    dismissError: () => {
      setError(null)
      setNoModel(false)
    },
  }
}
