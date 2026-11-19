import { Channel, invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import { IS_TAURI } from '@/lib/transport'

/**
 * Mises à jour de l'appli Tauri à partir du repo git du projet (côté Rust : src-tauri/src/updates.rs).
 * L'appli sait de quel commit elle a été construite. Elle le compare à ton repo et à GitHub, et
 * le bouton « Mettre à jour » fait git pull + construction, puis la remplace et la relance.
 */

export interface CommitInfo {
  hash: string
  summary: string
}

export interface UpdateStatus {
  /** Commit de la version installée, null si elle n'a pas été installée avec `npm run app:install`. */
  installed: string | null
  /** Commit qu'on obtiendrait en mettant à jour. */
  latest: string
  available: boolean
  commits: CommitInfo[]
  /** Pourquoi la mise à jour est impossible pour l'instant (modifs non commitées…). */
  blocked: string | null
  warnings: string[]
}

/** Vérifier : dans l'appli (même en mode dev). Mettre à jour : seulement dans l'appli installée. */
export const CAN_CHECK_UPDATES = IS_TAURI
export const CAN_UPDATE = IS_TAURI && import.meta.env.PROD

interface UpdateState {
  status: UpdateStatus | null
  checking: boolean
  checkError: string | null
  lastChecked: number | null
  running: boolean
  /** Étape en cours pendant la mise à jour (« Construction de l'appli »…). */
  step: string | null
  runError: string | null
}

let state: UpdateState = {
  status: null,
  checking: false,
  checkError: null,
  lastChecked: null,
  running: false,
  step: null,
  runError: null,
}
const listeners = new Set<() => void>()

function update(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** L'état des mises à jour, partagé entre la barre latérale et les Paramètres. */
export function useUpdates(): UpdateState {
  return useSyncExternalStore(subscribe, () => state)
}

export async function checkForUpdates(): Promise<void> {
  if (!CAN_CHECK_UPDATES || state.checking || state.running) return
  update({ checking: true, checkError: null })
  try {
    const status = await invoke<UpdateStatus>('check_updates')
    update({ status, checking: false, lastChecked: Date.now() })
  } catch (e) {
    update({ checking: false, checkError: String(e) })
  }
}

export async function startUpdate(): Promise<void> {
  if (!CAN_UPDATE || state.running) return
  update({ running: true, step: 'Préparation', runError: null })
  const onStep = new Channel<string>()
  onStep.onmessage = (step) => update({ step })
  try {
    // Si tout va bien, l'appli se ferme pendant cet appel et se relance à jour.
    await invoke('run_update', { onStep })
  } catch (e) {
    update({ running: false, step: null, runError: String(e) })
  }
}

const FIRST_CHECK_DELAY = 5_000
const CHECK_EVERY = 6 * 60 * 60 * 1000
let started = false

/** Vérifie peu après le lancement, puis toutes les 6 heures (appli installée seulement). */
export function startUpdateChecks(): void {
  if (!CAN_UPDATE || started) return
  started = true
  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY)
  setInterval(() => void checkForUpdates(), CHECK_EVERY)
}
