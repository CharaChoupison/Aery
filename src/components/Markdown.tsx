import { FileText, Globe, ImageOff } from 'lucide-react'
import { createContext, isValidElement, memo, useContext, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { CodeBlock } from '@/components/CodeBlock'

/**
 * SÉCURITÉ — à garder en tête si tu modifies ce fichier :
 *  - Pas de rehype-raw : le HTML écrit par le modèle reste du texte, il n'est jamais exécuté.
 *  - defaultUrlTransform retire les liens dangereux (javascript:, data:, vbscript:…).
 *  - Les images ne sont PAS chargées : une URL d'image peut servir à faire fuiter des
 *    données vers un serveur tiers (prompt injection). On affiche un lien à la place.
 */
/**
 * Liens entre notes du cerveau : [[Titre]] est transformé en lien « #note:<id> » (linkifyWikilinks)
 * avant le rendu. Ce contexte dit quoi faire au clic (ouvrir la note). Sans lui : simple texte.
 */
export const NoteLinkContext = createContext<((id: string) => void) | null>(null)

function NoteLink({ id, children }: { id: string; children: ReactNode }) {
  const open = useContext(NoteLinkContext)
  if (!open) return <span>{children}</span>
  return (
    <button
      type="button"
      onClick={() => open(id)}
      className="not-prose inline-flex translate-y-[-1px] items-center gap-1 rounded-md bg-muted px-1.5 py-px align-middle text-[0.9em] font-medium text-foreground transition-colors hover:bg-accent"
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {children}
    </button>
  )
}

const components: Components = {
  pre: CodeBlock,

  a: ({ node: _node, href, children, ...props }) => {
    // Lien vidé par defaultUrlTransform (ex. javascript:) → simple texte.
    if (!href) return <span>{children}</span>
    if (href.startsWith('#note:')) return <NoteLink id={href.slice(6)}>{children}</NoteLink>
    const site = citationSite(href, textOf(children))
    if (site) {
      // Citation de source → pastille discrète avec le nom du site, l'URL complète au survol.
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          title={href}
          className="not-prose ml-1 inline-flex max-w-48 translate-y-[-1px] items-center gap-1 rounded-full bg-muted px-2 py-px align-middle text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-foreground"
        >
          <Globe className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{site}</span>
        </a>
      )
    }
    return (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    )
  },

  img: ({ src, alt }) => {
    const url = typeof src === 'string' ? src : ''
    return (
      <a
        href={url || undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        title="Image non chargée automatiquement (sécurité). Clique pour l’ouvrir."
        className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-sm no-underline"
      >
        <ImageOff className="size-3.5" aria-hidden />
        {alt || 'Image'}
      </a>
    )
  },

  // Les grands tableaux défilent horizontalement au lieu de casser la mise en page.
  table: ({ node: _node, ...props }) => (
    <div className="my-4 overflow-x-auto">
      <table {...props} className="my-0" />
    </div>
  ),
}

/** Texte brut des enfants d'un lien (« **Dell** » → « Dell »). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

/**
 * Si le lien ressemble à une citation de source, renvoie le nom du site à afficher.
 * Citation = texte vide, symbole (↗, 🔗), numéro ([1]), l'URL elle-même ou son nom de domaine.
 * Un lien écrit dans une phrase (« la [doc officielle](…) ») reste un lien normal.
 */
function citationSite(href: string, text: string): string | null {
  let host: string
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    host = url.hostname.replace(/^www\./, '')
  } catch {
    return null
  }
  const t = text.trim().toLowerCase().replace(/^\[|\]$/g, '')
  const isCitation =
    !/[\p{L}\p{N}]/u.test(t) || // vide ou seulement des symboles
    /^\d{1,3}$/.test(t) || // [1]
    t === href.toLowerCase() ||
    t.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '') === host ||
    t === host
  return isCitation ? host : null
}

interface Props {
  content: string
}

/**
 * Rendu Markdown d'une réponse.
 * memo : un message terminé n'est pas recalculé à chaque nouveau mot d'un autre message.
 */
export const Markdown = memo(function Markdown({ content }: Props) {
  return (
    <div
      className={[
        'prose prose-neutral max-w-none dark:prose-invert',
        // Code en ligne : fond gris, sans les accents graves ajoutés par défaut par « prose ».
        'prose-code:rounded-md prose-code:bg-muted prose-code:px-1.5 prose-code:py-0.5 prose-code:font-normal',
        'prose-code:before:content-none prose-code:after:content-none',
        'prose-a:font-medium prose-a:text-blue-600 prose-a:decoration-blue-600/30 prose-a:underline-offset-3 hover:prose-a:decoration-current dark:prose-a:text-blue-400 dark:prose-a:decoration-blue-400/30',
        'prose-pre:m-0',
      ].join(' ')}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // detect: false → on ne colore que les blocs dont le langage est indiqué (```ts).
        // Deviner le langage à chaque mot reçu ralentirait le streaming.
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={components}
        urlTransform={defaultUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
