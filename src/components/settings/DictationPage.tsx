import { CircleAlert, Download, LoaderCircle, Mic, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { IconButton } from '@/components/IconButton'
import { Group, Notice, Row, SelectControl, UsageBar } from '@/components/settings/layout'
import { Button } from '@/components/ui/button'
import {
  cancelDictationDownload,
  deleteDictationModel,
  downloadDictationModel,
  formatBytes,
  LANGUAGE_LABELS,
  pickModel,
  refreshDictationModels,
  useDictationModels,
  type DictationModel,
} from '@/lib/dictation'
import { DICTATION_LANGUAGES, setPreferences, usePreferences, type DictationLanguage } from '@/lib/preferences'

/** Paramètres › Dictée : modèle Whisper (téléchargement, choix, suppression) et langue parlée. */
export function DictationPage() {
  const { models, downloading, progress, error } = useDictationModels()
  const { dictation } = usePreferences()
  const active = models ? pickModel(models, dictation.model) : null

  useEffect(() => {
    void refreshDictationModels()
  }, [])

  return (
    <>
      <p className="mb-6 flex gap-2 text-sm text-muted-foreground">
        <Mic className="mt-0.5 size-4 shrink-0" aria-hidden />
        <span>
          Le bouton micro du champ de saisie transcrit ta voix directement sur ton Mac, avec Whisper. Le son n’est jamais envoyé sur
          Internet : seul le modèle se télécharge, une seule fois.
        </span>
      </p>

      <Group title="Modèle de transcription" description="Plus le modèle est gros, plus il comprend bien, mais plus il met de temps.">
        {models === null ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Chargement…
          </p>
        ) : (
          models.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              active={model.id === active}
              downloading={downloading}
              progress={downloading === model.id ? progress : null}
            />
          ))
        )}
      </Group>
      {error && (
        <Notice tone="error" icon={CircleAlert}>
          {error}
        </Notice>
      )}

      <Group title="Dictée">
        <Row
          label="Langue parlée"
          description="Choisir ta langue évite les erreurs de détection sur les phrases courtes."
          control={
            <SelectControl<DictationLanguage>
              label="Langue parlée"
              value={dictation.language}
              options={DICTATION_LANGUAGES.map((value) => ({ value, label: LANGUAGE_LABELS[value] }))}
              onChange={(language) => setPreferences({ dictation: { ...dictation, language } })}
            />
          }
        />
        <Row
          label="Raccourcis pendant la dictée"
          description="Entrée pour terminer et transcrire, Échap pour annuler. La première fois, macOS te demande l’accès au micro."
        />
      </Group>
    </>
  )
}

function ModelRow({
  model,
  active,
  downloading,
  progress,
}: {
  model: DictationModel
  active: boolean
  downloading: string | null
  progress: { received: number; total: number } | null
}) {
  const { dictation } = usePreferences()
  const isDownloading = downloading === model.id

  let control
  if (isDownloading) {
    control = (
      <Button variant="outline" size="sm" onClick={cancelDictationDownload}>
        Annuler
      </Button>
    )
  } else if (model.installed) {
    control = (
      <div className="flex items-center gap-1">
        {active ? (
          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">Utilisé</span>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setPreferences({ dictation: { ...dictation, model: model.id } })}>
            Utiliser
          </Button>
        )}
        <IconButton label={`Supprimer le modèle « ${model.name} »`} onClick={() => void deleteDictationModel(model.id)}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
    )
  } else {
    control = (
      <Button
        variant="outline"
        size="sm"
        disabled={downloading !== null}
        onClick={() => {
          setPreferences({ dictation: { ...dictation, model: model.id } })
          void downloadDictationModel(model.id)
        }}
      >
        <Download aria-hidden />
        Télécharger
      </Button>
    )
  }

  return (
    <Row
      label={
        <span className="font-medium">
          {model.name} <span className="font-normal text-muted-foreground">· {formatBytes(model.size)}</span>
        </span>
      }
      description={model.description}
      control={control}
    >
      {isDownloading && progress && (
        <div className="flex flex-col gap-1.5">
          <UsageBar value={progress.received} max={progress.total} label={`Téléchargement du modèle « ${model.name} »`} share />
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatBytes(progress.received)} sur {formatBytes(progress.total)}
          </p>
        </div>
      )}
    </Row>
  )
}
