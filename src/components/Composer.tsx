import { ArrowUp, CircleAlert, Eye, FileText, Paperclip, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/IconButton'
import {
  ACCEPT,
  AttachmentError,
  formatSize,
  MAX_ATTACHMENTS,
  MAX_IMAGES,
  readAttachment,
  type Attachment,
} from '@/lib/attachments'
import { gsap, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

interface Props {
  onSend: (text: string, attachments: Attachment[]) => void
  onStop: () => void
  isStreaming: boolean // CETTE conversation reçoit une réponse → bouton Stop
  busy?: boolean // une AUTRE conversation reçoit une réponse → envoi bloqué (une seule à la fois)
  /** Quand cette valeur change (ex. changement de conversation), on remet le focus dans le champ. */
  focusKey?: string
  /** false = le modèle choisi ne lit pas les images (null = on ne sait pas). */
  modelReadsImages?: boolean | null
}

const MAX_HEIGHT = 200 // px : au-delà, le champ défile au lieu de grandir

// Sur écran tactile, Entrée fait un retour à la ligne (comme ChatGPT mobile) : on envoie avec le bouton.
const isTouch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

export function Composer({ onSend, onStop, isStreaming, busy = false, focusKey, modelReadsImages = null }: Props) {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [reading, setReading] = useState(0) // fichiers en cours de lecture
  const [fileError, setFileError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
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

  /** Lit les fichiers choisis (bouton, glisser-déposer ou coller) et les ajoute à la liste. */
  async function addFiles(files: File[]) {
    if (!files.length) return
    setFileError(null)
    const room = MAX_ATTACHMENTS - attachments.length
    if (files.length > room) setFileError(`${MAX_ATTACHMENTS} fichiers maximum par message.`)
    setReading((n) => n + Math.min(files.length, room))
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const attachment = await readAttachment(file)
        setAttachments((prev) => {
          if (attachment.kind === 'image' && prev.filter((a) => a.kind === 'image').length >= MAX_IMAGES) {
            setFileError(`${MAX_IMAGES} images maximum par message.`)
            return prev
          }
          return [...prev, attachment]
        })
      } catch (e) {
        setFileError(e instanceof AttachmentError ? e.message : `Impossible de lire « ${file.name} ».`)
      } finally {
        setReading((n) => n - 1)
      }
    }
  }

  const canSend = (value.trim() !== '' || attachments.length > 0) && reading === 0 && !busy

  function submit() {
    if (!canSend || isStreaming) return
    onSend(value, attachments)
    setValue('')
    setAttachments([])
    setFileError(null)
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

  const imageAttached = attachments.some((a) => a.kind === 'image')

  return (
    <div className="flex flex-col gap-2">
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return
          e.preventDefault()
          setDragging(false)
          void addFiles([...e.dataTransfer.files])
        }}
        className={cn(
          'flex flex-col rounded-3xl border bg-background p-2 shadow-sm transition-colors focus-within:border-ring',
          dragging && 'border-primary bg-primary/5',
        )}
      >
        {(attachments.length > 0 || reading > 0) && (
          <ul aria-label="Fichiers joints" className="flex flex-wrap gap-2 px-1 pt-1 pb-2">
            {attachments.map((a) => (
              <AttachmentChip key={a.id} attachment={a} onRemove={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))} />
            ))}
            {reading > 0 && (
              <li className="flex h-14 w-14 animate-pulse items-center justify-center rounded-xl bg-muted" aria-label="Lecture du fichier" />
            )}
          </ul>
        )}

        <div className="flex items-end gap-1">
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])])
              e.target.value = '' // pour pouvoir rechoisir le même fichier
            }}
          />
          <IconButton
            label="Joindre des fichiers (images, texte, code)"
            side="top"
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={attachments.length >= MAX_ATTACHMENTS}
            className="rounded-full text-muted-foreground"
          >
            <Paperclip className="size-5" aria-hidden />
          </IconButton>
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              // Une capture d'écran collée (Cmd+V) devient une pièce jointe.
              const files = [...e.clipboardData.files]
              if (files.length) {
                e.preventDefault()
                void addFiles(files)
              }
            }}
            rows={1}
            placeholder={dragging ? 'Dépose tes fichiers ici' : 'Écris ton message…'}
            aria-label="Message"
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-1.5 leading-6 outline-none placeholder:text-muted-foreground"
          />
          {isStreaming ? (
            <IconButton label="Arrêter la réponse" side="top" type="button" onClick={onStop} variant="default" size="icon-lg" className="rounded-full">
              <Square className="size-3.5 fill-current" aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label={busy ? 'Une réponse est en cours dans une autre conversation' : reading > 0 ? 'Lecture des fichiers…' : 'Envoyer'}
              side="top"
              type="submit"
              disabled={!canSend}
              variant="default"
              size="icon-lg"
              className="rounded-full"
            >
              <ArrowUp className="size-5" aria-hidden />
            </IconButton>
          )}
        </div>
      </form>

      {fileError && (
        <p role="alert" className="flex items-center gap-1.5 px-3 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden />
          {fileError}
        </p>
      )}
      {imageAttached && modelReadsImages === false && (
        <p role="status" className="flex items-center gap-1.5 px-3 text-xs text-muted-foreground">
          <Eye className="size-3.5 shrink-0" aria-hidden />
          Ce modèle ne lit pas les images : Auto choisira un modèle vision pour ce message.
        </p>
      )}
    </div>
  )
}

function AttachmentChip({ attachment: a, onRemove }: { attachment: Attachment; onRemove: () => void }) {
  return (
    <li className="group/chip relative">
      {a.kind === 'image' ? (
        <img src={a.dataUrl} alt={a.name} title={a.name} className="size-14 rounded-xl border object-cover" />
      ) : (
        <div className="flex h-14 max-w-56 items-center gap-2 rounded-xl border bg-muted/40 pr-3 pl-2" title={a.name}>
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{a.name}</span>
            <span className="block text-xs text-muted-foreground">{formatSize(a.size)}</span>
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Retirer « ${a.name} »`}
        title="Retirer"
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <X className="size-3" aria-hidden />
      </button>
    </li>
  )
}
