import { useRef, useState } from 'react'
import { CircleAlert, CircleCheck, Download, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Group, Notice, Row } from '@/components/settings/layout'
import {
  BackupError,
  MAX_BACKUP_BYTES,
  backupSummary,
  getLastBackupAt,
  importBackup,
  parseBackup,
  saveBackup,
  type Backup,
  type ImportReport,
} from '@/lib/backup'
import { IS_TAURI } from '@/lib/transport'

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
/** Au-delà, on rappelle gentiment de refaire une sauvegarde. */
const STALE_AFTER = 30 * 24 * 60 * 60 * 1000

function lastBackupText(at: number | null, now: number): string {
  if (at === null) return 'Aucune sauvegarde pour l’instant.'
  const days = Math.floor((now - at) / 86_400_000)
  const ago = days === 0 ? 'aujourd’hui' : days === 1 ? 'hier' : `il y a ${days} jours`
  return `Dernière sauvegarde : ${ago} (${dateFormat.format(at)}).`
}

function reportText(r: ImportReport): string {
  const added = r.conversations.added + r.projects.added + r.brain.added
  const updated = r.conversations.updated + r.projects.updated + r.brain.updated
  const kept = r.conversations.kept + r.projects.kept + r.brain.kept
  const parts = [`${added} ajouté${added > 1 ? 's' : ''}`, `${updated} mis à jour`, `${kept} déjà à jour`]
  return `${parts.join(', ')}${r.preferences ? ', préférences restaurées' : ''}.`
}

/** Paramètres › Général › Sauvegarde : exporter tout Aery dans un fichier, et le réimporter. */
export function BackupSection() {
  const [lastAt, setLastAt] = useState(getLastBackupAt)
  // Date.now() lu une fois au montage (pas pendant chaque rendu).
  const [now] = useState(Date.now)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Sauvegarde lue, en attente de confirmation. Gardée après la fermeture pour que le texte ne
  // disparaisse pas pendant l'animation de sortie de la boîte.
  const [pending, setPending] = useState<Backup | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [withPrefs, setWithPrefs] = useState(true)
  const [report, setReport] = useState<ImportReport | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  async function onExport() {
    setBusy('export')
    setError(null)
    try {
      if (await saveBackup()) setLastAt(getLastBackupAt())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'La sauvegarde a échoué.')
    } finally {
      setBusy(null)
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    setError(null)
    setReport(null)
    if (file.size > MAX_BACKUP_BYTES) return setError('Ce fichier est trop lourd pour être une sauvegarde d’Aery.')
    try {
      setPending(parseBackup(await file.text()))
      setWithPrefs(true)
      setConfirmOpen(true)
    } catch (e) {
      setError(e instanceof BackupError ? e.message : 'Impossible de lire ce fichier.')
    }
  }

  async function onConfirmImport() {
    if (!pending) return
    setBusy('import')
    try {
      setReport(await importBackup(pending, { preferences: withPrefs }))
    } catch {
      setError('L’import a échoué : rien n’a été modifié.')
    } finally {
      setBusy(null)
      setConfirmOpen(false)
    }
  }

  const stale = lastAt === null || now - lastAt > STALE_AFTER

  return (
    <Group
      title="Sauvegarde"
      description="Conversations, projets, second cerveau et préférences, dans un seul fichier. Ta clé FreeLLMAPI n’y est jamais."
    >
      <Row
        label="Exporter une sauvegarde"
        description={
          <>
            {lastBackupText(lastAt, now)}
            {stale && ' Tout est stocké dans l’appli seulement : une sauvegarde de temps en temps évite de tout perdre.'}
          </>
        }
        control={
          <Button variant="outline" onClick={() => void onExport()} disabled={busy !== null}>
            <Download aria-hidden />
            {busy === 'export' ? 'Export…' : 'Exporter'}
          </Button>
        }
      />
      <Row
        label="Importer une sauvegarde"
        description="Rien n’est effacé : ce qui manque est ajouté, et un élément n’est remplacé que par une version plus récente."
        control={
          <Button variant="outline" onClick={() => fileInput.current?.click()} disabled={busy !== null}>
            <Upload aria-hidden />
            Importer…
          </Button>
        }
      />
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0])
          e.target.value = '' // pour pouvoir rechoisir le même fichier
        }}
      />
      {error && (
        <Notice tone="error" icon={CircleAlert}>
          {error}
        </Notice>
      )}
      {report && (
        <Notice tone="success" icon={CircleCheck}>
          Import terminé : {reportText(report)}{' '}
          <button type="button" className="font-medium underline underline-offset-2" onClick={() => window.location.reload()}>
            Recharger {IS_TAURI ? 'l’appli' : 'la page'}
          </button>{' '}
          pour tout voir.
        </Notice>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !open && busy === null && setConfirmOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Importer cette sauvegarde ?</AlertDialogTitle>
            <AlertDialogDescription>
              {pending && (
                <>
                  Sauvegarde {pending.exportedAt ? `du ${dateFormat.format(pending.exportedAt)}` : 'sans date'} : {backupSummary(pending)}. Rien
                  ne sera effacé, et ce qui est plus récent ici sera gardé.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center justify-between gap-4 rounded-lg border p-3 text-sm">
            <span>
              Restaurer aussi les préférences
              <span className="block text-muted-foreground">Thème, profil, instructions, commandes… Remplace les réglages actuels.</span>
            </span>
            <Switch checked={withPrefs} onCheckedChange={setWithPrefs} aria-label="Restaurer aussi les préférences" />
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy !== null}>Annuler</AlertDialogCancel>
            <Button onClick={() => void onConfirmImport()} disabled={busy !== null}>
              {busy === 'import' ? 'Import…' : 'Importer'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Group>
  )
}
