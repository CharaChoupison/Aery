import { Channel, invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'
import type { DictationLanguage, DictationModelId } from '@/lib/preferences'
import { IS_TAURI } from '@/lib/transport'

/**
 * Dictée vocale 100 % locale (côté Rust : src-tauri/src/dictation.rs).
 * Le micro est enregistré par l'appli, puis Whisper transcrit le son sur le Mac :
 * rien n'est envoyé sur Internet. Seul le modèle se télécharge, une fois, depuis Hugging Face.
 */

/** La dictée passe par la partie Rust : appli seulement. */
export const CAN_DICTATE = IS_TAURI

export interface DictationModel {
  id: DictationModelId
  name: string
  description: string
  /** Taille du fichier, en octets. */
  size: number
  installed: boolean
}

interface DictationStatus {
  models: DictationModel[]
  downloading: DictationModelId | null
}

export const LANGUAGE_LABELS: Record<DictationLanguage, string> = {
  auto: 'Détection automatique',
  fr: 'Français',
  en: 'Anglais',
  es: 'Espagnol',
  de: 'Allemand',
  it: 'Italien',
  pt: 'Portugais',
  nl: 'Néerlandais',
}

// --- Modèles : petit store partagé entre les Paramètres et le champ de saisie ---------------
// Le téléchargement continue si on ferme les Paramètres : son état vit ici, pas dans la page.

interface ModelsState {
  models: DictationModel[] | null
  downloading: DictationModelId | null
  progress: { received: number; total: number } | null
  error: string | null
}

let state: ModelsState = { models: null, downloading: null, progress: null, error: null }
const listeners = new Set<() => void>()

function update(patch: Partial<ModelsState>) {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useDictationModels(): ModelsState {
  return useSyncExternalStore(subscribe, () => state)
}

export async function refreshDictationModels(): Promise<DictationModel[]> {
  if (!CAN_DICTATE) return []
  try {
    const status = await invoke<DictationStatus>('dictation_status')
    update({ models: status.models, downloading: state.downloading ?? status.downloading })
    return status.models
  } catch (e) {
    update({ error: String(e) })
    return []
  }
}

export async function downloadDictationModel(id: DictationModelId): Promise<void> {
  if (!CAN_DICTATE || state.downloading) return
  const model = state.models?.find((m) => m.id === id)
  update({ downloading: id, progress: { received: 0, total: model?.size ?? 0 }, error: null })
  const onProgress = new Channel<{ received: number; total: number }>()
  onProgress.onmessage = (progress) => update({ progress })
  try {
    await invoke('download_dictation_model', { id, onProgress })
  } catch (e) {
    const message = String(e)
    // Annulé par l'utilisateur : pas besoin d'afficher une erreur.
    if (!message.includes('annulé')) update({ error: message })
  } finally {
    update({ downloading: null, progress: null })
    await refreshDictationModels()
  }
}

export function cancelDictationDownload(): void {
  void invoke('cancel_dictation_download').catch(() => {})
}

export async function deleteDictationModel(id: DictationModelId): Promise<void> {
  try {
    await invoke('delete_dictation_model', { id })
    update({ error: null })
  } catch (e) {
    update({ error: String(e) })
  }
  await refreshDictationModels()
}

/** Le modèle à utiliser : celui choisi s'il est téléchargé, sinon n'importe quel modèle téléchargé. */
export function pickModel(models: DictationModel[], preferred: DictationModelId): DictationModelId | null {
  const installed = models.filter((m) => m.installed)
  return (installed.find((m) => m.id === preferred) ?? installed[0])?.id ?? null
}

// --- Enregistrement ----------------------------------------------------------------------

type DictationEvent =
  | { type: 'level'; level: number }
  | { type: 'limit' }
  | { type: 'partial'; committed: string; pending: string }

export interface DictationHandlers {
  /** Niveau du son (0 à 1), environ 16 fois par seconde. */
  onLevel: (level: number) => void
  /** Texte provisoire pendant que tu parles (il peut encore changer jusqu'à la fin). */
  onPartial: (text: string) => void
  /** Durée maximale atteinte : il faut terminer la dictée. */
  onLimit: () => void
}

/** D'où vient le son : le micro, ou le son du Mac (vidéo, réunion… tout ce qui sort des haut-parleurs). */
export type DictationSource = 'mic' | 'system'

/** Ouvre la source. La transcription démarre en direct, dans la langue donnée. */
export async function startDictation(
  model: DictationModelId,
  language: DictationLanguage,
  source: DictationSource,
  handlers: DictationHandlers,
): Promise<void> {
  const onEvent = new Channel<DictationEvent>()
  onEvent.onmessage = (event) => {
    if (event.type === 'level') handlers.onLevel(event.level)
    else if (event.type === 'partial') handlers.onPartial([event.committed, event.pending].filter(Boolean).join(' '))
    else handlers.onLimit()
  }
  await invoke('start_dictation', { model, language, source, onEvent })
}

/** Coupe le micro et renvoie le texte complet (vide si rien n'a été dit). */
export function stopDictation(): Promise<string> {
  return invoke<string>('stop_dictation')
}

export function cancelDictation(): void {
  void invoke('cancel_dictation').catch(() => {})
}

/** Le champ tel qu'il était au début de la dictée (texte + sélection). */
export interface DictationBase {
  text: string
  start: number
  end: number
}

/**
 * Met le texte dicté à la place de la sélection du début (avec les espaces qu'il faut autour).
 * Texte vide (dictée annulée) = le champ redevient comme avant. Renvoie aussi où placer le curseur.
 */
export function spliceDictation(base: DictationBase, text: string): { value: string; cursor: number } {
  if (!text) return { value: base.text, cursor: base.end }
  const before = base.text.slice(0, base.start)
  const after = base.text.slice(base.end)
  const spaceBefore = before && !/\s$/.test(before) && !/^\s/.test(text) ? ' ' : ''
  const spaceAfter = after && !/^\s/.test(after) ? ' ' : ''
  return { value: before + spaceBefore + text + spaceAfter + after, cursor: before.length + spaceBefore.length + text.length }
}

/** Demande à l'appli d'ouvrir les Paramètres sur la page Dictée (écouté par App.tsx). */
export function openDictationSettings(): void {
  window.dispatchEvent(new CustomEvent('aery:open-settings', { detail: 'dictation' }))
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1).replace('.', ',')} Go` : `${Math.round(bytes / 1e6)} Mo`
}
