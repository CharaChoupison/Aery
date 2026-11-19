import { ImageOff } from 'lucide-react'
import { memo } from 'react'
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
const components: Components = {
  pre: CodeBlock,

  a: ({ node: _node, href, children, ...props }) =>
    // Lien vidé par defaultUrlTransform (ex. javascript:) → simple texte.
    href ? (
      <a {...props} href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),

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
        'prose-a:text-blue-600 prose-a:underline-offset-2 dark:prose-a:text-blue-400',
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
