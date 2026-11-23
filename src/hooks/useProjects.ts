import { useCallback, useEffect, useState } from 'react'
import { deleteProjectFromDb, loadProjects, saveProject, type AppliedChanges } from '@/lib/db'
import { SYNC_APPLIED_EVENT } from '@/lib/sync'
import { newProject, type Project } from '@/lib/projects'

/** Les projets (dossiers de conversations), gardés dans IndexedDB comme l'historique. */
export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadProjects()
      .then((stored) => setProjects((prev) => [...prev, ...stored.filter((s) => !prev.some((p) => p.id === s.id))]))
      .catch(() => setError('Impossible de lire les projets.'))
  }, [])

  // Changements venus d'un autre appareil (déjà écrits dans IndexedDB par la synchro).
  useEffect(() => {
    const onApplied = (e: Event) => {
      const changes = (e as CustomEvent<AppliedChanges>).detail.projects
      if (!changes) return
      const incoming = changes.put as Project[]
      const byId = new Map(incoming.map((p) => [p.id, p]))
      setProjects((prev) => [
        ...incoming.filter((p) => !prev.some((q) => q.id === p.id)),
        ...prev.filter((p) => !changes.deleted.includes(p.id)).map((p) => byId.get(p.id) ?? p),
      ])
    }
    window.addEventListener(SYNC_APPLIED_EVENT, onApplied)
    return () => window.removeEventListener(SYNC_APPLIED_EVENT, onApplied)
  }, [])

  const persist = useCallback((project: Project) => {
    saveProject(project).catch(() => setError('L’enregistrement du projet a échoué.'))
  }, [])

  const createProject = useCallback(
    (fields: Partial<Omit<Project, 'id'>> & { name: string }) => {
      const project = { ...newProject(fields.name), ...fields, name: newProject(fields.name).name }
      setProjects((prev) => [project, ...prev])
      persist(project)
      return project
    },
    [persist],
  )

  const updateProject = useCallback(
    (id: string, patch: Partial<Omit<Project, 'id' | 'createdAt'>>) => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p
          const next = { ...p, ...patch, updatedAt: Date.now() }
          persist(next)
          return next
        }),
      )
    },
    [persist],
  )

  /** Supprime le projet ; ses conversations sont gardées et repassent hors projet. */
  const deleteProject = useCallback(async (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    await deleteProjectFromDb(id).catch(() => setError('La suppression du projet a échoué.'))
  }, [])

  const getProject = useCallback((id: string) => projects.find((p) => p.id === id), [projects])

  return { projects, error, createProject, updateProject, deleteProject, getProject }
}
