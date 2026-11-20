import { ChevronRight, CircleAlert, FileText, FolderTree, Globe, LoaderCircle, Search, SquareTerminal, Wrench } from 'lucide-react'
import { useState, type ComponentType } from 'react'
import { Appear } from '@/components/Appear'
import type { AgentStep } from '@/lib/agent/loop'
import { parseArgs } from '@/lib/agent/tools'
import { splitThinking } from '@/lib/thinking'
import { cn } from '@/lib/utils'

const TOOL_ICONS: Record<string, ComponentType<{ className?: string; 'aria-hidden'?: boolean }>> = {
  run_js: SquareTerminal,
  list_dir: FolderTree,
  read_file: FileText,
  search: Search,
  web_search: Globe,
}

/** Les étapes de l'agent, au-dessus de sa réponse : textes intermédiaires et appels d'outils repliables. */
export function AgentSteps({ steps, streaming }: { steps: AgentStep[]; streaming: boolean }) {
  return (
    <ol aria-label="Étapes de l’agent" className="mb-3 flex flex-col gap-0.5 border-l-2 pl-3">
      {steps.map((step) => (
        <li key={step.id}>
          <Appear enabled={streaming} from={{ autoAlpha: 0, x: -8, duration: 0.3 }}>
            {step.type === 'text' ? (
              <p className="py-1 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {splitThinking(step.text).answer || step.text}
              </p>
            ) : (
              <ToolStep step={step} />
            )}
          </Appear>
        </li>
      ))}
    </ol>
  )
}

function ToolStep({ step }: { step: AgentStep & { type: 'tool' } }) {
  const [open, setOpen] = useState(false)
  const Icon = step.status === 'running' ? LoaderCircle : step.status === 'error' ? CircleAlert : (TOOL_ICONS[step.tool] ?? Wrench)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={cn(
          'flex max-w-full items-center gap-1.5 rounded-md py-1 text-sm transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
          step.status === 'error' ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        <Icon className={cn('size-4 shrink-0', step.status === 'running' && 'animate-spin')} aria-hidden />
        <span className="truncate">{step.label}</span>
        {step.sources && (
          <span className="shrink-0 text-xs opacity-70">
            {step.sources.length} {step.sources.length > 1 ? 'résultats' : 'résultat'}
          </span>
        )}
        {step.durationMs !== undefined && (
          <span className="shrink-0 text-xs tabular-nums opacity-70">{formatDuration(step.durationMs)}</span>
        )}
        <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <Appear from={{ autoAlpha: 0, y: -6, duration: 0.25 }} className="mt-1 mb-2 flex flex-col gap-2">
          {step.sources ? (
            <SourceList sources={step.sources} />
          ) : (
            <>
              <Details title={step.tool === 'run_js' ? 'Code' : 'Paramètres'} text={formatArgs(step)} />
              {step.result !== undefined && <Details title="Résultat" text={step.result} error={step.status === 'error'} />}
            </>
          )}
        </Appear>
      )}
    </div>
  )
}

/** Recherche web : les pages trouvées, avec leur site. */
function SourceList({ sources }: { sources: NonNullable<(AgentStep & { type: 'tool' })['sources']> }) {
  return (
    <ul aria-label="Sources" className="flex flex-col gap-0.5 rounded-lg border bg-muted/40 p-1.5">
      {sources.map((source, i) => (
        <li key={`${i}-${source.url}`}>
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
            title={source.url}
            className="flex min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <span className="min-w-0 truncate">{source.title || source.url}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{hostOf(source.url)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function Details({ title, text, error = false }: { title: string; text: string; error?: boolean }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <pre
        className={cn(
          'max-h-72 overflow-auto rounded-lg border bg-muted/40 p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words',
          error && 'border-destructive/30 text-destructive',
        )}
      >
        {text}
      </pre>
    </div>
  )
}

/** run_js : on montre le code tel quel ; les autres : leurs paramètres en JSON lisible. */
function formatArgs(step: AgentStep & { type: 'tool' }): string {
  try {
    const args = parseArgs(step.args)
    if (step.tool === 'run_js' && typeof args.code === 'string') return args.code
    return Object.keys(args).length ? JSON.stringify(args, null, 2) : '(aucun)'
  } catch {
    return step.args || '(aucun)'
  }
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
}
