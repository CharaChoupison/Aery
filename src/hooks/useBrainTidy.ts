import { useCallback, useEffect, useRef, useState } from 'react'
import type { Brain } from '@/hooks/useBrain'
import { chatCompletion, isAbortError } from '@/lib/api'
import { findByTitle, type BrainItem, type BrainVersion } from '@/lib/brain'
import { exportVault, getVault } from '@/lib/brainExport'
import {
  applyMoc,
  applyProposal,
  buildTidyRequest,
  isDue,
  makeBatches,
  needsTidy,
  parseTidyResponse,
  TIDY_PROMPT,
  type TidyChange,
  type TidyRun,
} from '@/lib/brainTidy'
import { loadRunVersions, loadTidyRuns, saveBrainVersions, saveTidyRun } from '@/lib/db'
import { getPreferences, usePreferences } from '@/lib/preferences'
import type { Project } from '@/lib/projects'

/** Une requête de rangement ne doit pas rester bloquée (FreeLLMAPI peut se taire longtemps). */
const REQUEST_TIMEOUT = 120_000
/** On regarde toutes les minutes si l'heure du rangement est passée. */
const CHECK_EVERY = 60_000
const RETRY_AFTER_ERROR = 60 * 60_000

/** Signal annulé par l'utilisateur OU au bout de `ms` (AbortSignal.any n'existe pas sur les vieux macOS). */
function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const stop = () => controller.abort()
  if (signal.aborted) stop()
  else signal.addEventListener('abort', stop, { once: true })
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

export interface TidyProgress {
  done: number
  total: number
}

/**
 * Rangement du second cerveau : automatique (jour et heure des préférences, ou au lancement
 * suivant si l'appli était fermée), ou à la demande (« Ranger maintenant »). Puis export vers
 * le dossier Obsidian s'il y en a un (appli seulement).
 */
export function useBrainTidy(brain: Brain, projects: Project[], ready: boolean) {
  const { brainTidy: schedule } = usePreferences()
  const [runs, setRuns] = useState<TidyRun[]>([])
  const [runsLoaded, setRunsLoaded] = useState(false)
  const [progress, setProgress] = useState<TidyProgress | null>(null)
  const running = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const projectsRef = useRef(projects)
  useEffect(() => {
    projectsRef.current = projects
  })

  useEffect(() => {
    loadTidyRuns()
      .then(setRuns)
      .catch(() => {})
      .finally(() => setRunsLoaded(true))
  }, [])

  const remember = useCallback((run: TidyRun) => {
    setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)])
    void saveTidyRun(run).catch(() => {})
  }, [])

  /** Export vers le dossier Obsidian (s'il y en a un). Renvoie le bilan, ou undefined sans dossier. */
  const exportNow = useCallback(async (): Promise<TidyRun['export']> => {
    const vault = await getVault().catch(() => null)
    if (!vault) return undefined
    try {
      const r = await exportVault(brain.snapshot(), projectsRef.current)
      return { written: r.written, removed: r.removed, backedUp: r.backedUp }
    } catch (e) {
      return { written: 0, removed: 0, backedUp: 0, error: (e as Error).message }
    }
  }, [brain])

  const run = useCallback(
    async (trigger: TidyRun['trigger']): Promise<TidyRun | null> => {
      if (running.current) return null
      running.current = true
      const controller = new AbortController()
      abort.current = controller
      const started = Date.now()
      const all = brain.snapshot()
      const pending = all.filter(needsTidy).sort((a, b) => a.createdAt - b.createdAt)
      const batches = makeBatches(pending)
      const tidyRun: TidyRun = { id: crypto.randomUUID(), at: started, trigger, status: 'done', scanned: pending.length, changes: [], errors: [] }
      setProgress({ done: 0, total: batches.length })

      const changes: { before: BrainItem; after: BrainItem; change: TidyChange }[] = []
      const created: { after: BrainItem; change: TidyChange }[] = []
      try {
        for (const [index, batch] of batches.entries()) {
          if (controller.signal.aborted) break
          const resolve = (ref: string) => {
            const short = /^n(\d+)$/i.exec(ref.trim())
            return short ? batch[Number(short[1]) - 1] : findByTitle(brain.snapshot(), ref.replace(/^\[\[|\]\]$/g, ''))
          }
          try {
            const { content, model } = await chatCompletion(
              [
                { role: 'system', content: TIDY_PROMPT },
                { role: 'user', content: buildTidyRequest(batch, all) },
              ],
              { signal: withTimeout(controller.signal, REQUEST_TIMEOUT) },
            )
            if (model) tidyRun.model = model
            const parsed = parseTidyResponse(content)
            if (!parsed) {
              tidyRun.errors.push(`Lot ${index + 1} : réponse du modèle illisible, ces éléments seront rangés la prochaine fois.`)
              continue
            }
            const now = Date.now()
            batch.forEach((item, i) => {
              const proposal = parsed.notes.get(`n${i + 1}`)
              if (proposal) changes.push({ before: item, ...applyProposal(item, proposal, resolve, now) })
            })
            for (const m of parsed.mocs) {
              const known = [...brain.snapshot(), ...created.map((c) => c.after)]
              const result = applyMoc(m, resolve, known, now)
              if (!result) continue
              if (result.before) changes.push({ before: result.before, after: result.after, change: result.change })
              else created.push(result)
            }
          } catch (e) {
            if (isAbortError(e) && controller.signal.aborted) break
            const reason = isAbortError(e) ? 'pas de réponse au bout de 2 minutes' : (e as Error).message.replace(/\.$/, '') || 'la requête a échoué'
            tidyRun.errors.push(`Lot ${index + 1} : ${reason}.`)
          } finally {
            setProgress({ done: index + 1, total: batches.length })
          }
        }

        // Copie de chaque élément AVANT de le modifier : rien n'est jamais perdu.
        const versions: BrainVersion[] = changes.map(({ before }) => ({
          id: crypto.randomUUID(),
          itemId: before.id,
          runId: tidyRun.id,
          reason: 'tidy',
          savedAt: Date.now(),
          item: before,
        }))
        if (versions.length) await saveBrainVersions(versions)
        const applied = brain.commit(
          changes.map(({ before, after }) => ({ before, after })),
          created.map((c) => c.after),
        )
        tidyRun.changes = [...changes.filter((c) => applied.has(c.after.id)).map((c) => c.change), ...created.map((c) => c.change)]
        const skipped = changes.length - changes.filter((c) => applied.has(c.after.id)).length
        if (skipped) tidyRun.errors.push(`${skipped} élément${skipped > 1 ? 's' : ''} modifié${skipped > 1 ? 's' : ''} pendant le rangement, laissé${skipped > 1 ? 's' : ''} tel${skipped > 1 ? 's' : ''} quel${skipped > 1 ? 's' : ''}.`)
        if (controller.signal.aborted) tidyRun.errors.push('Rangement arrêté avant la fin.')
        tidyRun.status = tidyRun.errors.length ? (tidyRun.changes.length ? 'partial' : 'error') : 'done'
        if (batches.length === 0) tidyRun.status = 'done'
      } catch (e) {
        tidyRun.status = 'error'
        tidyRun.errors.push((e as Error).message || 'Le rangement a échoué.')
      }
      remember(tidyRun)
      // Le cerveau vient de changer : on met le coffre Obsidian à jour (s'il y en a un).
      const exported = await exportNow()
      if (exported) remember({ ...tidyRun, export: exported })
      setProgress(null)
      running.current = false
      abort.current = null
      return tidyRun
    },
    [brain, exportNow, remember],
  )

  /** Annule un rangement : chaque élément retrouve sa version d'avant, les index créés sont retirés. */
  const undo = useCallback(
    async (target: TidyRun) => {
      const changed = new Set(target.changes.filter((c) => !c.created).map((c) => c.itemId))
      const versions = (await loadRunVersions(target.id)).filter((v) => changed.has(v.itemId))
      for (const v of versions) await brain.restore(v)
      for (const c of target.changes.filter((c) => c.created)) {
        const item = brain.snapshot().find((i) => i.id === c.itemId)
        if (!item) continue
        await saveBrainVersions([{ id: crypto.randomUUID(), itemId: item.id, reason: 'restore', savedAt: Date.now(), item }])
        brain.remove(item.id)
      }
      remember({ ...target, status: 'undone' })
      const exported = await exportNow()
      if (exported?.error) throw new Error(exported.error)
    },
    [brain, exportNow, remember],
  )

  // Planning : au lancement (rendez-vous manqué) puis toutes les minutes. Un rangement annulé
  // compte comme fait ; un rangement en échec (FreeLLMAPI fermée…) est retenté une heure plus tard.
  const lastDone = runs.find((r) => r.status !== 'error')?.at ?? 0
  const lastError = runs.find((r) => r.status === 'error')?.at ?? 0
  const runRef = useRef(run)
  useEffect(() => {
    runRef.current = run
  })
  useEffect(() => {
    if (!ready || !brain.loaded || !runsLoaded) return
    const check = () => {
      const now = Date.now()
      if (running.current || now - lastError < RETRY_AFTER_ERROR) return
      if (isDue(getPreferences().brainTidy, lastDone, now)) void runRef.current('auto')
    }
    check()
    const timer = setInterval(check, CHECK_EVERY)
    return () => clearInterval(timer)
  }, [ready, brain.loaded, runsLoaded, lastDone, lastError, schedule])

  return {
    runs,
    progress,
    running: progress !== null,
    pending: brain.items.filter(needsTidy).length,
    runNow: () => run('manual'),
    stop: () => abort.current?.abort(),
    undo,
    exportNow,
  }
}

export type BrainTidy = ReturnType<typeof useBrainTidy>
