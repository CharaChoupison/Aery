import { isValidElement, useRef, type ComponentProps, type ReactNode } from 'react'
import { CopyButton } from '@/components/CopyButton'

/** Récupère le langage depuis la classe du <code> enfant (« hljs language-ts » → « ts »). */
function getLanguage(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string }>(children)) return null
  return /language-([\w+#-]+)/.exec(children.props.className ?? '')?.[1] ?? null
}

/** Remplace le <pre> du Markdown : bandeau avec le langage + bouton copier. */
export function CodeBlock({ children, node: _node, ...props }: ComponentProps<'pre'> & { node?: unknown }) {
  const preRef = useRef<HTMLPreElement>(null)
  const language = getLanguage(children)

  return (
    <div className="not-prose my-4 overflow-hidden rounded-xl border border-white/10 bg-[#0d1117] text-[#e6edf3]">
      <div className="flex items-center justify-between border-b border-white/10 py-1 pr-1 pl-4 text-xs text-white/60">
        <span className="font-mono">{language ?? 'code'}</span>
        <CopyButton
          label="Copier le code"
          // textContent : le texte brut, sans les balises de coloration.
          getText={() => preRef.current?.textContent ?? ''}
          className="text-white/60 hover:bg-white/10 hover:text-white"
        />
      </div>
      <pre
        ref={preRef}
        {...props}
        // Le thème highlight.js ajoute son propre fond et marge sur <code> : on les neutralise.
        className="overflow-x-auto p-4 text-sm leading-relaxed [&_code.hljs]:bg-transparent [&_code.hljs]:p-0"
      >
        {children}
      </pre>
    </div>
  )
}
