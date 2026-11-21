import { Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { IconButton } from '@/components/IconButton'
import { Button } from '@/components/ui/button'
import type { UiMessage } from '@/hooks/useChat'
import { cn } from '@/lib/utils'

interface Props {
  message: UiMessage
  /** D'autres échanges suivent la réponse à ce message (ils seront remplacés). */
  hasLater: boolean
  /** Envoie le texte modifié (absent = pas de bouton Modifier, par ex. pendant une réponse). Renvoie une erreur, ou null. */
  onEdit?: (text: string) => string | null
}

/** Bulle de l'utilisateur + actions au survol (Copier, Modifier), ou zone d'édition. */
export function UserMessage({ message: m, hasLater, onEdit }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // La zone grandit avec le texte ; curseur à la fin à l'ouverture.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`
  }, [draft, editing])
  useEffect(() => {
    if (!editing) return
    const el = textareaRef.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  function start() {
    setDraft(m.content)
    setError(null)
    setEditing(true)
  }
  function submit() {
    if (!onEdit) return
    const problem = onEdit(draft)
    if (problem) setError(problem)
    else setEditing(false)
  }

  if (editing) {
    return (
      <div className="w-full rounded-3xl border bg-muted/50 p-3">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false)
            else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          aria-label="Modifier le message"
          className="block w-full resize-none bg-transparent px-1 text-base outline-none"
        />
        {error && <p className="mt-2 px-1 text-sm text-destructive">{error}</p>}
        <div className="mt-2 flex items-center justify-end gap-2">
          {hasLater && <span className="mr-auto px-1 text-xs text-muted-foreground">Les messages suivants seront remplacés.</span>}
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Annuler
          </Button>
          <Button size="sm" onClick={submit} disabled={!onEdit || (!draft.trim() && !m.attachments?.length)}>
            Envoyer
          </Button>
        </div>
      </div>
    )
  }

  return (
    <>
      {m.content && (
        // wrap-anywhere (et pas break-words) : une longue URL sans espace peut être coupée
        // n'importe où, sinon la bulle s'élargit à toute l'URL et déborde à gauche.
        <div className="max-w-full whitespace-pre-wrap wrap-anywhere rounded-3xl bg-muted px-4 py-2.5 select-text">{m.content}</div>
      )}
      <div
        className={cn(
          '-mt-1 flex items-center text-muted-foreground transition-opacity select-none',
          'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        {m.content && <CopyButton label="Copier le message" getText={() => m.content} side="bottom" />}
        {onEdit && (
          <IconButton label="Modifier" size="icon-sm" onClick={start}>
            <Pencil className="size-3.5" aria-hidden />
          </IconButton>
        )}
      </div>
    </>
  )
}
