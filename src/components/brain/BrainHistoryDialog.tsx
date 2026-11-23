import { History, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Markdown } from '@/components/Markdown'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { itemTitle, type BrainItem, type BrainVersion } from '@/lib/brain'
import { loadBrainVersions } from '@/lib/db'
import { cn } from '@/lib/utils'

const dateFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

const REASONS: Record<BrainVersion['reason'], string> = {
  tidy: 'Avant le rangement',
  restore: 'Avant une restauration',
  merge: 'Avant une fusion',
}

/** Versions gardées d'un élément (avant chaque rangement ou restauration), avec aperçu et « Restaurer ». */
export function BrainHistoryDialog({ item, onRestore, onClose }: { item: BrainItem; onRestore: (v: BrainVersion) => Promise<void>; onClose: () => void }) {
  const [versions, setVersions] = useState<BrainVersion[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    loadBrainVersions(item.id)
      .then((v) => {
        setVersions(v)
        setSelected(v[0]?.id ?? null)
      })
      .catch(() => setVersions([]))
  }, [item.id])

  const current = versions?.find((v) => v.id === selected)

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[min(40rem,calc(100dvh-7rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <div className="flex h-14 shrink-0 items-center gap-2 border-b px-5 pr-12">
          <History className="size-4 text-muted-foreground" aria-hidden />
          <DialogTitle className="truncate text-base font-semibold">Versions précédentes</DialogTitle>
          <DialogDescription className="sr-only">Copies gardées de « {itemTitle(item)} » avant chaque modification automatique.</DialogDescription>
        </div>
        {versions === null ? null : versions.length === 0 ? (
          <p className="p-6 text-sm text-muted-foreground">
            Aucune version gardée pour l’instant. Une copie est faite automatiquement avant chaque rangement qui modifie cette page.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1">
            <ul className="w-56 shrink-0 overflow-y-auto border-r p-2" aria-label="Versions">
              {versions.map((v) => (
                <li key={v.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(v.id)}
                    aria-current={v.id === selected}
                    className={cn('w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted', v.id === selected && 'bg-muted')}
                  >
                    <span className="block first-letter:uppercase">{dateFormat.format(v.savedAt)}</span>
                    <span className="block text-xs text-muted-foreground">{REASONS[v.reason]}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex min-w-0 flex-1 flex-col">
              {current && (
                <>
                  <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
                    <h2 className="mb-1 text-xl font-semibold">{itemTitle(current.item)}</h2>
                    <p className="mb-4 text-xs text-muted-foreground">
                      {current.item.folder ?? 'Boîte de réception'}
                      {current.item.tags.length > 0 && ` · ${current.item.tags.map((t) => `#${t}`).join(' ')}`}
                    </p>
                    {current.item.content.trim() ? <Markdown content={current.item.content} /> : <p className="text-sm text-muted-foreground">(vide)</p>}
                  </div>
                  <div className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3">
                    <p className="mr-auto text-xs text-muted-foreground">La version actuelle est gardée aussi : tu pourras y revenir.</p>
                    <Button
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true)
                        await onRestore(current)
                        onClose()
                      }}
                    >
                      <RotateCcw aria-hidden />
                      Restaurer cette version
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
