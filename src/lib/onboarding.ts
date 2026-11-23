// Premier lancement de l'appli (Tauri seulement) : trouver FreeLLMAPI, tester la clé, vérifier qu'un
// modèle de chat répond. La partie Rust (src-tauri/src/onboarding.rs) fait les vérifications ; la clé
// part vers Rust, qui la teste puis la range dans le Trousseau : l'interface ne la revoit jamais.

import type { ModelInfo } from './api'
import { invokeCommand } from './transport'

export interface FreellmStatus {
  installed: boolean
  running: boolean
  reachable: boolean
  /** Port où FreeLLMAPI répond (ou celui essayé en premier). */
  port: number
  savedPort: number
}

export type ConnectResult =
  | { status: 'ok'; keyHint: string | null; port: number }
  | { status: 'invalidKey'; message: string }
  | { status: 'unreachable'; message: string }
  | { status: 'error'; message: string }

/** `port` : port des options avancées ; `launch` : démarrer FreeLLMAPI si elle ne répond pas (25 s max). */
export function getFreellmStatus(options: { port?: number; launch: boolean }): Promise<FreellmStatus> {
  return invokeCommand<FreellmStatus>('freellm_status', { port: options.port ?? null, launch: options.launch })
}

export function connectFreellm(key: string, port: number): Promise<ConnectResult> {
  return invokeCommand<ConnectResult>('connect_freellm', { key, port })
}

export const openFreellm = () => invokeCommand<void>('open_freellm')
export const openFreellmDownload = () => invokeCommand<void>('open_freellm_download')

/** `auto`, `fusion` et les chaînes `auto:<nom>` ne sont pas de vrais modèles : ils en demandent un. */
export function isRealChatModel(model: Pick<ModelInfo, 'id'>): boolean {
  return model.id !== 'auto' && model.id !== 'fusion' && !model.id.startsWith('auto:')
}

/** Erreur réglée en réparant la connexion : clé refusée ou absente, FreeLLMAPI injoignable. */
export function isConnectionError(error: { code?: string; status?: number }): boolean {
  return error.code === 'no_key' || error.code === 'upstream_unreachable' || error.status === 401 || error.status === 403
}

/** Premier message proposé (modifiable : la personne l'envoie elle-même). */
export const STARTER_MESSAGE =
  'Salut ! Présente-toi en quelques phrases, puis donne-moi trois idées concrètes de choses que tu peux faire pour moi au quotidien.'

// --- Mise en avant de « Garder dans le cerveau » après la première réponse --------------------
// Simple préférence (rien de secret) : '1' = à montrer, absent = déjà vu ou jamais demandé.

const SAVE_HINT_KEY = 'freellm-chat:save-hint'

export function readSaveHint(): boolean {
  try {
    return localStorage.getItem(SAVE_HINT_KEY) === '1'
  } catch {
    return false
  }
}

export function writeSaveHint(on: boolean): void {
  try {
    if (on) localStorage.setItem(SAVE_HINT_KEY, '1')
    else localStorage.removeItem(SAVE_HINT_KEY)
  } catch {
    // pas grave : la mise en avant ne s'affichera simplement pas
  }
}
