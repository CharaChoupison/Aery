import { useEffect, useState } from 'react'
import { IS_TAURI } from './transport'

/**
 * Appli Tauri sur macOS : la barre de titre est « en overlay » (tauri.conf.json), donc les
 * 3 boutons de fenêtre (rouge/orange/vert) sont dessinés PAR-DESSUS le coin haut gauche de la page.
 * Ce hook dit s'il faut leur laisser de la place. En plein écran, macOS les cache : plus besoin.
 */
const IS_MAC_APP = IS_TAURI && navigator.userAgent.includes('Mac')

/** Largeur réservée aux boutons de fenêtre (ils commencent à x = 20 px, et finissent vers 80 px). */
export const TRAFFIC_LIGHTS_INSET = 'pl-[92px]'
/** Pareil, mais seulement en fenêtre étroite (barre latérale remplacée par le panneau mobile). */
export const TRAFFIC_LIGHTS_INSET_NARROW = 'max-md:pl-[92px]'

export function useTrafficLights(): boolean {
  const [visible, setVisible] = useState(IS_MAC_APP)

  useEffect(() => {
    if (!IS_MAC_APP) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const win = getCurrentWindow()
      const update = async () => setVisible(!(await win.isFullscreen()))
      await update()
      // Entrer/sortir du plein écran redimensionne la fenêtre.
      const stop = await win.onResized(() => void update())
      if (cancelled) stop()
      else unlisten = stop
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return visible
}

/**
 * À mettre sur une zone vide d'une barre : on peut y attraper la fenêtre pour la déplacer
 * (et double-cliquer pour l'agrandir). Seul l'élément lui-même compte, pas ses enfants,
 * donc les boutons à l'intérieur restent cliquables.
 */
export const dragRegion = IS_TAURI ? { 'data-tauri-drag-region': '' } : {}
