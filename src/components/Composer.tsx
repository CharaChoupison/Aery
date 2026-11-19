import { ArrowUp, Square } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import { gsap, useMotion } from '@/lib/motion'

interface Props {
  onSend: (text: string) => void
  onStop: () => void
  isStreaming: boolean // CETTE conversation reçoit une réponse → bouton Stop
  busy?: boolean // une AUTRE conversation reçoit une réponse → envoi bloqué (une seule à la fois)
  /** Quand cette valeur change (ex. changement de conversation), on remet le focus dans le champ. */
  focusKey?: string
}

const MAX_HEIGHT = 200 // px : au-delà, le champ défile au lieu de grandir

// Sur écran tactile, Entrée fait un retour à la ligne (comme ChatGPT mobile) : on envoie avec le bouton.
const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function Composer({ onSend, onStop, isStreaming, busy = false, focusKey }: Props) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const motion = useMotion()

  // Le champ grandit avec le texte : on remet la hauteur à « auto », puis on prend la hauteur du contenu.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [value])

  useEffect(() => {
    if (!isTouch) ref.current?.focus()
  }, [focusKey])

  function submit() {
    if (!value.trim() || isStreaming || busy) return
    onSend(value)
    setValue('')
    // Petit « pouf » de la zone de saisie à l'envoi (animation ponctuelle, pas besoin de useGSAP).
    if (motion && formRef.current) {
      gsap.fromTo(formRef.current, { scale: 0.98 }, { scale: 1, duration: 0.5, ease: 'elastic.out(1, 0.4)', clearProps: 'transform' })
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // isComposing : l'utilisateur tape un caractère composé (accents sur certains claviers, japonais…).
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      className="flex items-end gap-2 rounded-3xl border bg-background p-2 pl-4 shadow-sm transition-colors focus-within:border-ring"
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder="Écris ton message…"
        aria-label="Message"
        className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent py-1.5 leading-6 outline-none placeholder:text-muted-foreground"
      />
      {isStreaming ? (
        <IconButton label="Arrêter la réponse" side="top" type="button" onClick={onStop} variant="default" size="icon-lg" className="rounded-full">
          <Square className="size-3.5 fill-current" aria-hidden />
        </IconButton>
      ) : (
        <IconButton
          label={busy ? 'Une réponse est en cours dans une autre conversation' : 'Envoyer'}
          side="top"
          type="submit"
          disabled={!value.trim() || busy}
          variant="default"
          size="icon-lg"
          className="rounded-full"
        >
          <ArrowUp className="size-5" aria-hidden />
        </IconButton>
      )}
    </form>
  )
}
