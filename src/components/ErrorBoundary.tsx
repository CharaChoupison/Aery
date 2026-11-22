import { Component, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Filet de sécurité : si un composant plante PENDANT LE RENDU, React démonte tout l'arbre au-dessus
 * jusqu'au premier ErrorBoundary. Sans lui = page blanche. Avec lui = un message et de quoi repartir.
 *
 * Ça n'attrape pas les erreurs dans les gestionnaires d'événements ni le code asynchrone
 * (fetch, setTimeout) : celles-là sont déjà gérées là où elles arrivent.
 *
 * Seul un composant « classe » peut faire ça (React n'a pas encore de hook équivalent).
 *
 *  - `resetKey` : quand il change (autre conversation, autre page…), on réessaie tout seul ;
 *  - `fullScreen` : version plein écran, pour le filet tout en haut de l'appli.
 */
interface Props {
  children: ReactNode
  resetKey?: string
  fullScreen?: boolean
}

interface State {
  error: Error | null
  resetKey?: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // On a changé d'endroit : la vue qui plantait n'est peut-être plus là, on retente.
    if (props.resetKey !== state.resetKey) return { resetKey: props.resetKey, error: null }
    return null
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Vue plantée :', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const { fullScreen } = this.props
    return (
      <div
        role="alert"
        className={cn(
          'flex flex-col items-center justify-center gap-4 px-6 text-center',
          fullScreen ? 'h-dvh bg-background text-foreground' : 'min-h-0 flex-1 overflow-y-auto py-10',
        )}
      >
        <span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
          <TriangleAlert className="size-6" aria-hidden />
        </span>
        <div className="max-w-md">
          <h2 className="text-xl font-semibold">{fullScreen ? 'L’appli a planté' : 'Cette vue a planté'}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tes données ne sont pas touchées : seul l’affichage a eu un problème.
            {!fullScreen && ' Tu peux réessayer, ou ouvrir autre chose dans la barre latérale.'}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {!fullScreen && (
            <Button variant="outline" onClick={() => this.setState({ error: null })}>
              <RotateCcw aria-hidden />
              Réessayer
            </Button>
          )}
          <Button variant={fullScreen ? 'default' : 'ghost'} onClick={() => window.location.reload()}>
            <RefreshCw aria-hidden />
            Recharger
          </Button>
        </div>
        <details className="w-full max-w-lg text-left text-xs text-muted-foreground">
          <summary className="cursor-pointer text-center select-none">Détails techniques</summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-muted p-3 whitespace-pre-wrap">{error.stack ?? error.message}</pre>
        </details>
      </div>
    )
  }
}
