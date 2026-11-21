import { Check, CircleAlert, LoaderCircle, Mic, X } from 'lucide-react'
import { DictationWave } from '@/components/DictationWave'
import { IconButton } from '@/components/IconButton'
import type { Dictation } from '@/hooks/useDictation'
import { openDictationSettings } from '@/lib/dictation'
import { cn } from '@/lib/utils'

/** Pendant la dictée : ondes du micro (ou « Derniers mots… »), Annuler et Terminer. */
export function DictationControls({ dictation, className }: { dictation: Dictation; className?: string }) {
  return (
    <div className={cn('flex items-end gap-1', className)}>
      {dictation.phase === 'transcribing' ? (
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 px-2 text-sm text-muted-foreground" role="status">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden />
          Derniers mots…
        </div>
      ) : (
        <div className="flex h-9 min-w-0 flex-1">
          <DictationWave levels={dictation.levels} startedAt={dictation.startedAt} />
        </div>
      )}
      <IconButton
        label="Annuler la dictée (Échap)"
        side="top"
        type="button"
        onClick={dictation.cancel}
        disabled={dictation.phase === 'transcribing'}
        size="icon-lg"
        className="rounded-full text-muted-foreground"
      >
        <X className="size-5" aria-hidden />
      </IconButton>
      <IconButton
        label="Terminer (Entrée)"
        side="top"
        type="button"
        onClick={() => void dictation.stop()}
        disabled={dictation.phase !== 'recording'}
        variant="default"
        size="icon-lg"
        className="rounded-full"
      >
        <Check className="size-5" aria-hidden />
      </IconButton>
    </div>
  )
}

/** Erreur de la dernière dictée, ou invitation à télécharger un modèle. */
export function DictationNotices({ dictation, className }: { dictation: Dictation; className?: string }) {
  if (dictation.error) {
    return (
      <p role="alert" className={cn('flex items-center gap-1.5 text-xs text-destructive', className)}>
        <CircleAlert className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">{dictation.error}</span>
        <button type="button" onClick={dictation.dismissError} className="ml-auto shrink-0 underline-offset-2 hover:underline">
          Fermer
        </button>
      </p>
    )
  }
  if (dictation.noModel) {
    return (
      <p role="status" className={cn('flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground', className)}>
        <Mic className="size-3.5 shrink-0" aria-hidden />
        Pour dicter, télécharge d’abord un modèle de transcription (une seule fois).
        <button
          type="button"
          onClick={() => {
            dictation.dismissError()
            openDictationSettings()
          }}
          className="font-medium text-foreground underline underline-offset-2"
        >
          Ouvrir Paramètres › Dictée
        </button>
      </p>
    )
  }
  return null
}
