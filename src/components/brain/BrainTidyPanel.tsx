import {
  ArrowRight,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FolderOpen,
  FolderSync,
  Info,
  LoaderCircle,
  PenLine,
  Sparkles,
  Square,
  Undo2,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Collapse } from '@/components/Collapse'
import { Group, Notice, Row, SelectControl, UsageBar } from '@/components/settings/layout'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import type { Brain } from '@/hooks/useBrain'
import type { BrainTidy } from '@/hooks/useBrainTidy'
import { INBOX_FOLDER } from '@/lib/brain'
import { CAN_EXPORT, exportVault, forgetVault, getVault, pickVault } from '@/lib/brainExport'
import { DAY_LABELS, MAX_PER_RUN, nextSlot, runSummary, type TidyRun } from '@/lib/brainTidy'
import { setPreferences, usePreferences } from '@/lib/preferences'
import type { Project } from '@/lib/projects'
import { cn } from '@/lib/utils'

const DAYS = [1, 2, 3, 4, 5, 6, 0].map((d) => ({ value: String(d), label: DAY_LABELS[d].replace(/^./, (c) => c.toUpperCase()) }))
const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${h} h` }))
const dateFormat = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/**
 * Onglet « Rangement » du Cerveau : le réglage hebdomadaire, « Ranger maintenant »,
 * l'export vers un dossier Obsidian, et l'historique des rangements (avec « Annuler »).
 */
export function BrainTidyPanel({ tidy, brain, projects, onOpen }: { tidy: BrainTidy; brain: Brain; projects: Project[]; onOpen: (id: string) => void }) {
  const { brainTidy: schedule } = usePreferences()
  const [vault, setVault] = useState<string | null>(null)
  const [vaultMessage, setVaultMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [undoError, setUndoError] = useState<string | null>(null)

  useEffect(() => {
    void getVault().then(setVault).catch(() => {})
  }, [])

  // Changer le planning repart de maintenant : pas de rangement surprise juste après un réglage.
  const updateSchedule = (patch: Partial<typeof schedule>) => setPreferences({ brainTidy: { ...schedule, ...patch, since: Date.now() } })

  async function chooseVault() {
    setVaultMessage(null)
    try {
      const picked = await pickVault()
      if (picked) {
        setVault(picked)
        await exportNow()
      }
    } catch (e) {
      setVaultMessage({ tone: 'error', text: (e as Error).message })
    }
  }

  async function exportNow() {
    setExporting(true)
    setVaultMessage(null)
    try {
      const r = await exportVault(brain.snapshot(), projects)
      setVaultMessage({
        tone: 'success',
        text: `Export terminé : ${r.written} fichier${r.written > 1 ? 's' : ''} écrit${r.written > 1 ? 's' : ''}, ${r.unchanged} inchangé${r.unchanged > 1 ? 's' : ''}${r.removed ? `, ${r.removed} retiré${r.removed > 1 ? 's' : ''}` : ''}${r.backedUp ? `, ${r.backedUp} sauvegardé${r.backedUp > 1 ? 's' : ''} dans .aery/sauvegardes (modifiés dans Obsidian)` : ''}.`,
      })
    } catch (e) {
      setVaultMessage({ tone: 'error', text: (e as Error).message })
    } finally {
      setExporting(false)
    }
  }

  const latest = tidy.runs.find((r) => r.status !== 'undone' && r.changes.length > 0)

  return (
    <div className="flex flex-col gap-2 pt-2">
      <Group
        title="Rangement automatique"
        description="Une fois par semaine, le modèle range ce que tu as ajouté depuis la dernière fois : un dossier (méthode PARA), des tags, des liens entre notes liées, des notes d’index, et une légère réécriture des notes courtes. Une copie de chaque note est gardée avant."
      >
        <Row
          label="Ranger chaque semaine"
          description={
            schedule.enabled
              ? `Prochain rangement : ${dateFormat.format(nextSlot(schedule, Date.now()))}. Si l’appli est fermée à ce moment-là, ce sera au prochain lancement.`
              : 'Désactivé : rien n’est rangé sans toi.'
          }
          control={<Switch checked={schedule.enabled} onCheckedChange={(enabled) => updateSchedule({ enabled })} aria-label="Ranger chaque semaine" />}
        />
        {schedule.enabled && (
          <Row
            label="Jour et heure"
            control={
              <div className="flex items-center gap-1">
                <SelectControl label="Jour du rangement" value={String(schedule.day)} options={DAYS} onChange={(v) => updateSchedule({ day: Number(v) })} />
                <SelectControl label="Heure du rangement" value={String(schedule.hour)} options={HOURS} onChange={(v) => updateSchedule({ hour: Number(v) })} />
              </div>
            }
          />
        )}
        <Row
          label="Ranger maintenant"
          description={
            tidy.pending === 0
              ? 'Tout est rangé.'
              : `${tidy.pending} élément${tidy.pending > 1 ? 's' : ''} à ranger${tidy.pending > MAX_PER_RUN ? ` (${MAX_PER_RUN} par rangement, le reste au suivant)` : ''}. Une requête par petit lot.`
          }
          control={
            tidy.running ? (
              <Button variant="outline" className="h-9" onClick={tidy.stop}>
                <Square aria-hidden />
                Arrêter
              </Button>
            ) : (
              <Button className="h-9" disabled={tidy.pending === 0} onClick={() => void tidy.runNow()}>
                <Sparkles aria-hidden />
                Ranger maintenant
              </Button>
            )
          }
        >
          {tidy.progress && tidy.progress.total > 0 && (
            <div className="flex items-center gap-3">
              <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
              <div className="flex-1">
                <UsageBar value={tidy.progress.done} max={tidy.progress.total} label="Avancement du rangement" share />
              </div>
              <span className="text-xs text-muted-foreground tabular-nums">
                Lot {Math.min(tidy.progress.done + 1, tidy.progress.total)} / {tidy.progress.total}
              </span>
            </div>
          )}
        </Row>
      </Group>

      <Group
        title="Dossier Obsidian"
        description="Un fichier Markdown par élément, rangé dans son dossier, avec un frontmatter YAML (tags, dates) et des liens [[…]]. Ouvre ce dossier comme coffre dans Obsidian."
      >
        {CAN_EXPORT ? (
          <>
            <Row
              label={vault ? 'Exporté dans' : 'Aucun dossier choisi'}
              description={
                vault ? (
                  <span className="break-all">{vault}</span>
                ) : (
                  'Choisis un dossier vide (ou un coffre Obsidian existant). Il est mis à jour après chaque rangement.'
                )
              }
              control={
                <div className="flex gap-2">
                  {vault && (
                    <Button variant="outline" className="h-9" disabled={exporting} onClick={() => void exportNow()}>
                      {exporting ? <LoaderCircle className="animate-spin" aria-hidden /> : <FolderSync aria-hidden />}
                      Exporter
                    </Button>
                  )}
                  <Button variant={vault ? 'ghost' : 'default'} className="h-9" onClick={() => void chooseVault()}>
                    <FolderOpen aria-hidden />
                    {vault ? 'Changer' : 'Choisir un dossier'}
                  </Button>
                </div>
              }
            />
            {vault && (
              <p className="pb-2 text-xs text-muted-foreground">
                Rien n’est perdu : un fichier que tu as modifié dans Obsidian est copié dans <code>.aery/sauvegardes</code> avant d’être remplacé, et Aery ne
                supprime que ses propres fichiers.{' '}
                <button
                  type="button"
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => {
                    void forgetVault().then(() => setVault(null))
                    setVaultMessage(null)
                  }}
                >
                  Ne plus exporter
                </button>
              </p>
            )}
            {vaultMessage && (
              <Notice tone={vaultMessage.tone} icon={vaultMessage.tone === 'error' ? CircleAlert : CircleCheck}>
                {vaultMessage.text}
              </Notice>
            )}
          </>
        ) : (
          <Notice tone="warning" icon={Info}>
            L’export vers un dossier se fait dans l’appli Aery (le navigateur ne peut pas écrire sur ton disque). Le rangement, lui, marche ici aussi.
          </Notice>
        )}
      </Group>

      <Group title="Historique des rangements">
        {undoError && (
          <Notice tone="error" icon={CircleAlert}>
            {undoError}
          </Notice>
        )}
        {tidy.runs.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">Pas encore de rangement.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-2xl border">
            {tidy.runs.map((run) => (
              <RunRow
                key={run.id}
                run={run}
                canUndo={run.id === latest?.id && !tidy.running}
                onOpen={onOpen}
                exists={(id) => brain.items.some((i) => i.id === id)}
                onUndo={async () => {
                  setUndoError(null)
                  try {
                    await tidy.undo(run)
                  } catch (e) {
                    setUndoError((e as Error).message)
                  }
                }}
              />
            ))}
          </ul>
        )}
      </Group>
    </div>
  )
}

function RunRow({ run, canUndo, onUndo, onOpen, exists }: { run: TidyRun; canUndo: boolean; onUndo: () => Promise<void>; onOpen: (id: string) => void; exists: (id: string) => boolean }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const summary = runSummary(run)
  // L'erreur déjà affichée comme résumé n'est pas répétée dans le détail.
  const errors = run.errors[0] === summary ? run.errors.slice(1) : run.errors
  const hasDetails = run.changes.length > 0 || errors.length > 0
  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5">
          {run.status === 'error' ? (
            <CircleAlert className="size-4 text-destructive" aria-label="Échec" />
          ) : run.status === 'undone' ? (
            <Undo2 className="size-4 text-muted-foreground" aria-label="Annulé" />
          ) : (
            <CircleCheck className="size-4 text-muted-foreground" aria-label="Terminé" />
          )}
        </span>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => hasDetails && setOpen(!open)} aria-expanded={hasDetails ? open : undefined}>
          <span className="flex items-center gap-1.5 text-sm font-medium first-letter:uppercase">
            {dateFormat.format(run.at)}
            <span className="font-normal text-muted-foreground">· {run.trigger === 'auto' ? 'automatique' : 'à la demande'}</span>
            {run.status === 'undone' && <span className="font-normal text-muted-foreground">· annulé</span>}
            {hasDetails && <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden />}
          </span>
          <span className="block text-sm text-muted-foreground">{summary}</span>
          {run.export && (
            <span className={cn('block text-xs', run.export.error ? 'text-destructive' : 'text-muted-foreground')}>
              {run.export.error ? `Export Obsidian : ${run.export.error}` : `Export Obsidian : ${run.export.written} fichier${run.export.written > 1 ? 's' : ''} mis à jour`}
            </span>
          )}
        </button>
        {canUndo && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await onUndo()
              setBusy(false)
            }}
            title="Chaque élément retrouve sa version d’avant ce rangement"
          >
            <Undo2 aria-hidden />
            Annuler
          </Button>
        )}
      </div>
      <Collapse open={open}>
        <ul className="mt-2 ml-7 flex flex-col gap-1 text-sm">
          {errors.map((e) => (
            <li key={e} className="text-destructive">
              {e}
            </li>
          ))}
          {run.changes.map((c) => (
            <li key={c.itemId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {exists(c.itemId) ? (
                <button type="button" className="font-medium hover:underline" onClick={() => onOpen(c.itemId)}>
                  {c.title}
                </button>
              ) : (
                <span className="font-medium text-muted-foreground line-through">{c.title}</span>
              )}
              {c.created && <span className="text-xs text-muted-foreground">index créé dans {c.toFolder}</span>}
              {!c.created && c.toFolder !== c.fromFolder && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {c.fromFolder ?? INBOX_FOLDER}
                  <ArrowRight className="size-3" aria-hidden />
                  {c.toFolder ?? INBOX_FOLDER}
                </span>
              )}
              {c.oldTitle && <span className="text-xs text-muted-foreground">(avant : {c.oldTitle})</span>}
              {c.addedTags.length > 0 && <span className="text-xs text-muted-foreground">{c.addedTags.map((t) => `#${t}`).join(' ')}</span>}
              {c.rewritten && !c.created && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <PenLine className="size-3" aria-hidden />
                  réécrite
                </span>
              )}
              {c.links > 0 && !c.created && <span className="text-xs text-muted-foreground">+{c.links} lien{c.links > 1 ? 's' : ''}</span>}
            </li>
          ))}
        </ul>
      </Collapse>
    </li>
  )
}
