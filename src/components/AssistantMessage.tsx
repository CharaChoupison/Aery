import { BookmarkCheck, BookmarkPlus, Brain, ChevronRight, Cpu, Eye, GitBranchPlus, LoaderCircle, RotateCcw, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import { AgentSteps } from '@/components/AgentSteps'
import { Appear } from '@/components/Appear'
import { CopyButton } from '@/components/CopyButton'
import { IconButton } from '@/components/IconButton'
import { Markdown } from '@/components/Markdown'
import { TypingDots } from '@/components/TypingDots'
import type { UiMessage } from '@/hooks/useChat'
import { splitThinking } from '@/lib/thinking'
import { cn } from '@/lib/utils'

interface Props {
  message: UiMessage
  streaming: boolean // cette réponse est en train d'arriver
  isLast: boolean
  /** Déjà gardée dans le second cerveau. */
  saved?: boolean
  /** « Garder dans le cerveau » (absent = bouton masqué). */
  onSave?: (answer: string) => void
  /** « Réessayer » : refait cette réponse (absent = bouton masqué, seulement sur la dernière). */
  onRetry?: () => void
  /** « Dupliquer à partir d'ici » : nouvelle conversation qui s'arrête à cette réponse. */
  onDuplicate?: () => void
}

/** Une réponse de l'assistant : réflexion éventuelle, texte Markdown, actions. */
export function AssistantMessage({ message: m, streaming, isLast, saved = false, onSave, onRetry, onDuplicate }: Props) {
  // La réflexion peut arriver dans un champ à part (m.reasoning) ou entre balises <think> dans le texte.
  const inline = splitThinking(m.content)
  const thinking = [m.reasoning, inline.thinking].filter(Boolean).join('\n\n')
  const answer = inline.answer
  const steps = m.steps ?? []
  const lastStep = steps.at(-1)
  const toolRunning = lastStep?.type === 'tool' && lastStep.status === 'running'
  const thinkingNow = streaming && answer === '' && steps.length === 0

  return (
    <div className="group min-w-0 break-words">
      {thinking && <Reasoning text={thinking} active={thinkingNow} />}

      {steps.length > 0 && <AgentSteps steps={steps} streaming={streaming} />}

      {/* Points d'attente : au début, et entre deux étapes de l'agent (le modèle réfléchit à la suite). */}
      {answer === '' && streaming && !toolRunning && (!thinking || steps.length > 0) ? (
        <Waiting />
      ) : (
        answer && <Markdown content={answer} />
      )}

      {m.note && (
        <span className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Eye className="mt-px size-3 shrink-0" aria-hidden />
          {m.note}
        </span>
      )}

      {m.stopped && (
        <span className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <Square className="size-3" aria-hidden />
          Réponse interrompue
        </span>
      )}

      {/* Actions sous la réponse : visibles sur la dernière, au survol pour les autres. */}
      {answer !== '' && !streaming && (
        <div
          className={cn(
            'mt-1 flex min-w-0 items-center text-muted-foreground transition-opacity select-none',
            !isLast && 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <CopyButton label="Copier la réponse" getText={() => answer} side="bottom" />
          {onSave && (
            <IconButton
              label={saved ? 'Déjà dans le cerveau' : 'Garder dans le cerveau'}
              size="icon-sm"
              onClick={() => onSave(answer)}
              aria-pressed={saved}
              className={cn(saved && 'text-primary')}
            >
              {saved ? <BookmarkCheck className="size-3.5" aria-hidden /> : <BookmarkPlus className="size-3.5" aria-hidden />}
            </IconButton>
          )}
          {onRetry && (
            <IconButton label="Réessayer" size="icon-sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" aria-hidden />
            </IconButton>
          )}
          {onDuplicate && (
            <IconButton label="Dupliquer à partir d’ici" size="icon-sm" onClick={onDuplicate}>
              <GitBranchPlus className="size-3.5" aria-hidden />
            </IconButton>
          )}
          {m.model && (
            <span className="ml-1 flex min-w-0 items-center gap-1 text-xs" title={`Modèle qui a réellement répondu : ${m.model}`}>
              {/* Le nom reste sélectionnable : on peut vouloir le copier. */}
              <Cpu className="size-3 shrink-0" aria-hidden />
              <span className="truncate select-text">{m.model}</span>
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** Points animés ; après 8 s, un petit texte rassure : ce n'est pas planté. */
function Waiting() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 8000)
    return () => clearTimeout(t)
  }, [])
  return (
    <span className="flex items-center gap-3 text-sm text-muted-foreground">
      <TypingDots />
      {slow && (
        <Appear from={{ autoAlpha: 0, x: -6 }}>
          En attente du modèle… Les modèles gratuits sont parfois lents (abandon après 60 s).
        </Appear>
      )}
    </span>
  )
}

/**
 * Bloc « Réflexion » repliable, comme ChatGPT : ouvert pendant que le modèle réfléchit,
 * replié automatiquement dès que la réponse commence — sauf si l'utilisateur l'a ouvert/fermé lui-même.
 */
function Reasoning({ text, active }: { text: string; active: boolean }) {
  const [userChoice, setUserChoice] = useState<boolean | null>(null)
  const open = userChoice ?? active

  return (
    <div className="mb-3">
      <button
        onClick={() => setUserChoice(!open)}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        {active ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <Brain className="size-4" aria-hidden />}
        {active ? 'Réflexion en cours…' : 'Réflexion'}
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <Appear
          from={{ autoAlpha: 0, y: -6, duration: 0.3 }}
          className="mt-2 border-l-2 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground"
        >
          {text}
        </Appear>
      )}
    </div>
  )
}
