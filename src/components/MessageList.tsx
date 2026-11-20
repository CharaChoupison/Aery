import { ArrowDown, CircleAlert, FileText, RotateCcw } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { Appear } from '@/components/Appear'
import { Button } from '@/components/ui/button'
import { AssistantMessage } from '@/components/AssistantMessage'
import { gsap, useGSAP, useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'
import type { ChatError, UiMessage } from '@/hooks/useChat'
import { formatSize } from '@/lib/attachments'

interface Props {
  messages: UiMessage[]
  isStreaming: boolean // cette conversation reçoit une réponse en ce moment
  error: ChatError | null
  canRetry: boolean
  onRetry: () => void
  /** Largeur max de la colonne (réglage « Largeur de la conversation »). */
  widthClass?: string
}

/** Distance (en px) en dessous de laquelle on considère qu'on est « en bas ». */
const STICK_THRESHOLD = 80

export function MessageList({ messages, isStreaming, error, canRetry, onRetry, widthClass = 'max-w-3xl' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  // useRef et pas useState : on n'a pas besoin de re-render quand ça change.
  const atBottomRef = useRef(true)
  const prevCountRef = useRef(0)
  const [showJump, setShowJump] = useState(false)
  const motion = useMotion()
  // Messages déjà là à l'ouverture de la conversation : ils ne s'animent pas un par un…
  const [initialIds] = useState(() => new Set(messages.map((m) => m.id)))
  const listRef = useRef<HTMLDivElement>(null)

  // …mais les derniers arrivent en cascade quand on ouvre la conversation.
  useGSAP(
    () => {
      if (!motion || !listRef.current) return
      const items = Array.from(listRef.current.children).slice(-4)
      gsap.from(items, { autoAlpha: 0, y: 16, stagger: 0.06, clearProps: 'all' })
    },
    { scope: listRef },
  )

  /**
   * Défilement automatique :
   *  - nouveau message (envoi, début de réponse) → on descend toujours ;
   *  - le texte s'allonge pendant le streaming → on suit, SAUF si l'utilisateur
   *    est remonté lire plus haut (on ne lui arrache pas la page des mains).
   * useLayoutEffect : s'exécute avant que le navigateur dessine, donc pas de saut visible.
   */
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const added = messages.length > prevCountRef.current
    prevCountRef.current = messages.length
    if (added || atBottomRef.current) {
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
    }
  }, [messages, error])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    atBottomRef.current = distance < STICK_THRESHOLD
    setShowJump(distance > 200)
  }

  function jumpToBottom() {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }

  const lastId = messages.at(-1)?.id

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        <div ref={listRef} className={cn('mx-auto flex flex-col gap-6 px-4 py-6', widthClass)}>
          {messages.map((m) =>
            m.role === 'user' ? (
              // Message envoyé : il « monte » depuis la zone de saisie, avec un léger rebond.
              <Appear
                key={m.id}
                enabled={!initialIds.has(m.id)}
                from={{ autoAlpha: 0, y: 24, scale: 0.96, transformOrigin: '100% 100%', ease: 'back.out(1.6)' }}
                className="flex max-w-[85%] flex-col items-end gap-2 self-end"
              >
                {m.attachments && m.attachments.length > 0 && <UserAttachments message={m} />}
                {m.content && (
                  <div className="whitespace-pre-wrap break-words rounded-3xl bg-muted px-4 py-2.5">{m.content}</div>
                )}
              </Appear>
            ) : (
              <Appear key={m.id} enabled={!initialIds.has(m.id)} from={{ autoAlpha: 0, y: 10, delay: 0.1 }}>
                <AssistantMessage message={m} streaming={isStreaming && m.id === lastId} isLast={m.id === lastId} />
              </Appear>
            ),
          )}

          {error && (
            // Petite secousse : on remarque tout de suite qu'il y a un souci.
            <Appear
              role="alert"
              from={{ x: -10, ease: 'elastic.out(1, 0.3)', duration: 0.7 }}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
            >
              <span className="flex gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                {error.message}
              </span>
              {canRetry && (
                <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
                  <RotateCcw className="size-3.5" aria-hidden />
                  Réessayer
                </Button>
              )}
            </Appear>
          )}
        </div>
      </div>

      {showJump && (
        <Appear className="absolute bottom-3 left-1/2 -translate-x-1/2" from={{ autoAlpha: 0, scale: 0.5, ease: 'back.out(2)' }}>
          <Button variant="outline" size="icon" onClick={jumpToBottom} aria-label="Descendre en bas" className="rounded-full shadow-md">
            <ArrowDown className="size-4" aria-hidden />
          </Button>
        </Appear>
      )}
    </div>
  )
}

/** Images et fichiers joints à un message, au-dessus de la bulle. */
function UserAttachments({ message }: { message: UiMessage }) {
  return (
    <ul aria-label="Fichiers joints" className="flex flex-wrap justify-end gap-2">
      {message.attachments!.map((a) =>
        a.kind === 'image' ? (
          <li key={a.id}>
            <img src={a.dataUrl} alt={a.name} title={a.name} className="max-h-60 max-w-full rounded-2xl border object-contain sm:max-w-72" />
          </li>
        ) : (
          <li key={a.id} className="flex max-w-64 items-center gap-2 rounded-2xl border px-3 py-2" title={a.name}>
            <FileText className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{a.name}</span>
              <span className="block text-xs text-muted-foreground">{formatSize(a.size)}</span>
            </span>
          </li>
        ),
      )}
    </ul>
  )
}
