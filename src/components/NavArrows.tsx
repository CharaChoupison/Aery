import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { IconButton } from '@/components/IconButton'

export interface NavControls {
  canGoBack: boolean
  canGoForward: boolean
  back: () => void
  forward: () => void
}

const IS_MAC = navigator.userAgent.includes('Mac')
const MOD = IS_MAC ? '⌘' : 'Ctrl+'

/** Flèches Précédent / Suivant, comme dans un navigateur (ou l'appli Claude). */
export function NavArrows({ nav }: { nav: NavControls }) {
  return (
    <>
      <IconButton label={`Précédent (${MOD}[)`} onClick={nav.back} disabled={!nav.canGoBack}>
        <ArrowLeft className="size-4" aria-hidden />
      </IconButton>
      <IconButton label={`Suivant (${MOD}])`} onClick={nav.forward} disabled={!nav.canGoForward}>
        <ArrowRight className="size-4" aria-hidden />
      </IconButton>
    </>
  )
}

/** Raccourcis : ⌘[ / ⌘] (comme Safari et Finder), et les boutons « précédent/suivant » des souris. */
export function useNavShortcuts(controls: NavControls) {
  // Ref : les écouteurs sont posés une seule fois, mais appellent toujours la version à jour.
  const ref = useRef(controls)
  useEffect(() => {
    ref.current = controls
  })
  useEffect(() => {
    const nav = {
      back: () => ref.current.back(),
      forward: () => ref.current.forward(),
    }
    function onKey(e: KeyboardEvent) {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.altKey) return
      if (e.key === '[') {
        e.preventDefault()
        nav.back()
      } else if (e.key === ']') {
        e.preventDefault()
        nav.forward()
      }
    }
    function onMouse(e: MouseEvent) {
      if (e.button === 3) nav.back()
      if (e.button === 4) nav.forward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [])
}
