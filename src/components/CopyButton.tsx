import { Check, Copy } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'

interface Props {
  /** Fonction appelée au clic, qui renvoie le texte à copier (lu au dernier moment). */
  getText: () => string
  label?: string
  className?: string
  side?: 'top' | 'bottom'
}

/** Bouton « copier » : l'icône devient une coche pendant 2 secondes. */
export function CopyButton({ getText, label = 'Copier', className, side = 'top' }: Props) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  async function copy() {
    try {
      await navigator.clipboard.writeText(getText())
      setCopied(true)
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Presse-papiers refusé par le navigateur : on ne fait rien de plus.
    }
  }

  return (
    <IconButton label={copied ? 'Copié !' : label} side={side} size="icon-sm" onClick={copy} className={className}>
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </IconButton>
  )
}
