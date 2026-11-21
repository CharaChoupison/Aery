import { ArrowUp, Check, CircleAlert, LoaderCircle, RotateCcw, Sparkles, Square, TextCursorInput, Undo2, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/Markdown'
import { gsap, useMotion } from '@/lib/motion'
import { Button } from '@/components/ui/button'
import { ApiError, isAbortError, streamChat } from '@/lib/api'
import { BRAIN_LIMITS } from '@/lib/brain'
import { buildNoteAiMessages, cleanNoteAiOutput, spliceNote } from '@/lib/noteAi'
import { cn } from '@/lib/utils'

/** Zone de la note visée : une sélection (start < end) ou un point d'insertion (start = end). */
export interface NoteRange {
  start: number
  end: number
}

type Phase = 'idle' | 'streaming' | 'ready' | 'error'

/**
 * Barre « Demande à l'IA » en bas d'une note. Le texte du modèle arrive dans un aperçu ;
 * la note n'est modifiée que sur « Insérer » / « Remplacer », et « Annuler » remet l'ancien texte.
 * ⌘J met le curseur dans la barre, Échap arrête ou referme l'aperçu.
 */
export function NoteAiBar({
  title,
  content,
  model,
  getRange,
  onApply,
}: {
  title: string
  content: string
  model?: string
  /** Sélection ou curseur dans la zone d'écriture (null = on n'y a pas touché). */
  getRange: () => NoteRange | null
  onApply: (content: string, caret: number) => void
}) {
  const [request, setRequest] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [result, setResult] = useState('')
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [usedModel, setUsedModel] = useState<string | null>(null)
  /** Zone visée, figée au moment de l'envoi (la sélection peut bouger pendant la génération). */
  const [target, setTarget] = useState<NoteRange | null>(null)
  /** Ce que la dernière application a remplacé, tant que la note n'a pas été retouchée depuis. */
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null)
  /** Sélection vue quand on entre dans la barre : affichée en pastille. */
  const [selection, setSelection] = useState<NoteRange | null>(null)
  const [lastRequest, setLastRequest] = useState('')
  /** Repliée en bulle (en bas à droite) tant qu'on ne s'en sert pas : la génération reste discrète. */
  const [expanded, setExpanded] = useState(false)
  const motion = useMotion()
  const controller = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // ⌘J (Ctrl+J) : aller dans la barre, depuis n'importe où dans la page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        expand()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => () => controller.current?.abort(), [])

  // La barre grandit avec la demande (5 lignes max).
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [request])

  function expand() {
    setExpanded(true)
    // Le champ n'existe qu'une fois la barre dépliée : on attend le rendu (pas requestAnimationFrame,
    // qui ne tourne pas fenêtre en arrière-plan).
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  const undoable = undo !== null && undo.after === content

  async function run(text: string) {
    if (!text.trim() || phase === 'streaming') return
    const range = getRange()
    const picked = range && range.start < range.end ? range : null
    setTarget(range)
    setSelection(picked)
    setLastRequest(text)
    setResult('')
    setError(null)
    setUsedModel(null)
    setThinking(false)
    setUndo(null)
    setPhase('streaming')
    const ctrl = new AbortController()
    controller.current = ctrl
    let raw = ''
    try {
      const messages = buildNoteAiMessages({ title, content, selection: picked ? content.slice(picked.start, picked.end) : undefined }, text)
      for await (const event of streamChat(messages, { model, signal: ctrl.signal })) {
        if (event.type === 'text') {
          raw += event.text
          setThinking(false)
          setResult(cleanNoteAiOutput(raw))
        } else if (event.type === 'reasoning') setThinking(true)
        else if (event.type === 'model') setUsedModel(event.model)
      }
      const final = cleanNoteAiOutput(raw)
      setResult(final)
      if (final) {
        setPhase('ready')
        setRequest('')
      } else {
        setError('Le modèle n’a rien écrit. Réessaie, ou reformule ta demande.')
        setPhase('error')
      }
    } catch (e) {
      if (isAbortError(e) && ctrl.signal.aborted) {
        // Arrêté par l'utilisateur : on garde ce qui est déjà arrivé, s'il y a quelque chose.
        const partial = cleanNoteAiOutput(raw)
        setResult(partial)
        setPhase(partial ? 'ready' : 'idle')
        return
      }
      setError(e instanceof ApiError && e.code === 'timeout' ? 'Pas de réponse au bout de 60 secondes : les fournisseurs sont peut-être saturés. Réessaie.' : (e as Error).message || 'La requête a échoué.')
      setPhase('error')
    } finally {
      if (controller.current === ctrl) controller.current = null
      setThinking(false)
    }
  }

  function apply(mode: 'insert' | 'replace') {
    if (!result) return
    let start: number
    let end: number
    if (mode === 'replace') {
      ;[start, end] = selection ? [selection.start, selection.end] : [0, content.length]
    } else {
      // Après la sélection, au curseur, ou à la fin de la note.
      const at = selection ? selection.end : (target?.start ?? content.length)
      start = end = Math.min(at, content.length)
    }
    const next = spliceNote(content, start, end, result)
    const after = next.content.slice(0, BRAIN_LIMITS.content)
    setUndo({ before: content, after })
    onApply(after, Math.min(next.caret, after.length))
    discard()
    setExpanded(false)
  }

  function discard() {
    controller.current?.abort()
    setPhase('idle')
    setResult('')
    setError(null)
    setSelection(null)
    if (!request.trim()) setExpanded(false)
  }

  const open = phase !== 'idle'
  const shown = expanded || open

  // Dépliage : la bulle s'étire vers la gauche jusqu'à la largeur de la page.
  useLayoutEffect(() => {
    const bar = barRef.current
    if (!shown || !bar || !motion) return
    const tween = gsap.fromTo(bar, { width: 48 }, { width: '100%', duration: 0.35, ease: 'power3.out', clearProps: 'width' })
    return () => {
      tween.kill()
    }
  }, [shown, motion])
  const replaceLabel = selection ? 'Remplacer la sélection' : 'Remplacer la note'
  const insertLabel = selection ? 'Insérer après' : 'Insérer'

  return (
    // Posée par-dessus le bas de la page (le parent est en `relative`) ; seuls ses éléments captent la souris.
    <div className="pointer-events-none absolute inset-x-0 bottom-0 px-4 pb-4">
      <div className="mx-auto flex w-full max-w-3xl flex-col items-end gap-2">
        {open && (
          <div className="pointer-events-auto flex max-h-[45dvh] w-full flex-col overflow-hidden rounded-2xl border bg-background shadow-lg" aria-live="polite">
            <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
              <Sparkles className="size-3.5" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {lastRequest}
                {usedModel && <span className="ml-2 text-muted-foreground/70">· {usedModel}</span>}
              </span>
              <Button variant="ghost" size="icon-xs" onClick={discard} aria-label="Fermer la proposition" title="Fermer la proposition (Échap)">
                <X aria-hidden />
              </Button>
            </div>
            <div className="min-h-0 overflow-y-auto px-4 py-3">
              {phase === 'error' ? (
                <p role="alert" className="flex gap-2 text-sm text-destructive">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  {error}
                </p>
              ) : result ? (
                <Markdown content={result} />
              ) : (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  {thinking ? 'Le modèle réfléchit…' : 'Écriture en cours…'}
                </p>
              )}
            </div>
            {(phase === 'ready' || phase === 'error') && (
              <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
                {phase === 'ready' && (
                  <>
                    <Button size="sm" onClick={() => apply(selection ? 'replace' : 'insert')}>
                      <Check aria-hidden />
                      {selection ? replaceLabel : insertLabel}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => apply(selection ? 'insert' : 'replace')}>
                      {selection ? insertLabel : replaceLabel}
                    </Button>
                  </>
                )}
                <Button size="sm" variant="ghost" onClick={() => void run(lastRequest)}>
                  <RotateCcw aria-hidden />
                  Réessayer
                </Button>
                <Button size="sm" variant="ghost" className="ml-auto" onClick={discard}>
                  Abandonner
                </Button>
              </div>
            )}
          </div>
        )}

        {undoable && !open && (
          <div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
            Texte de l’IA ajouté à la note.
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                onApply(undo.before, undo.before.length)
                setUndo(null)
              }}
            >
              <Undo2 aria-hidden />
              Annuler
            </Button>
          </div>
        )}

        {!shown ? (
          <button
            type="button"
            onClick={expand}
            aria-label="Demander à l’IA (⌘J)"
            title="Demander à l’IA (⌘J)"
            className="pointer-events-auto flex size-12 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-md transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Sparkles className="size-5" aria-hidden />
          </button>
        ) : (
        <div
          ref={barRef}
          onBlur={(e) => {
            // On clique ailleurs sans avoir rien demandé : la barre redevient une bulle.
            if (!e.currentTarget.contains(e.relatedTarget) && !request.trim() && phase === 'idle') setExpanded(false)
          }}
          className="pointer-events-auto flex min-h-12 w-full items-center gap-2 rounded-3xl border bg-background py-1.5 pr-1.5 pl-4 shadow-md focus-within:ring-2 focus-within:ring-ring/40"
        >
          <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          {selection && phase === 'idle' && (
            <span className="flex h-7 shrink-0 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground">
              <TextCursorInput className="size-3.5" aria-hidden />
              Sélection
              <button type="button" onClick={() => setSelection(null)} aria-label="Ignorer la sélection" title="Ignorer la sélection" className="rounded-full p-0.5 hover:text-foreground">
                <X className="size-3" aria-hidden />
              </button>
            </span>
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onFocus={() => {
              if (phase !== 'idle') return
              const r = getRange()
              setSelection(r && r.start < r.end ? r : null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void run(request)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                if (open) discard()
                else {
                  setRequest('')
                  setExpanded(false)
                }
              }
            }}
            placeholder={selection ? 'Que faire de la sélection ? (reformuler, raccourcir…)' : 'Demande à l’IA d’écrire dans la note… (⌘J)'}
            aria-label="Demande à l’IA"
            className="max-h-36 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 outline-none placeholder:text-muted-foreground/70"
          />
          {phase === 'streaming' ? (
            <Button size="icon-sm" variant="secondary" className="shrink-0 rounded-full" onClick={() => controller.current?.abort()} aria-label="Arrêter" title="Arrêter">
              <Square className="fill-current" aria-hidden />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              className={cn('shrink-0 rounded-full', !request.trim() && 'opacity-50')}
              disabled={!request.trim()}
              onClick={() => void run(request)}
              aria-label="Envoyer la demande"
              title="Envoyer (Entrée)"
            >
              <ArrowUp aria-hidden />
            </Button>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
