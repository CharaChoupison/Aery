import { useSyncExternalStore } from 'react'

/**
 * Préférences de l'interface (thème, animations, réglages du modèle…).
 *
 * Rien de secret ici, donc localStorage suffit (la clé API, elle, reste côté serveur/Trousseau).
 * Petit « store » maison : getPreferences() pour lire n'importe où, usePreferences() dans les
 * composants (re-render automatique quand ça change), setPreferences() pour modifier.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
/** system = suivre « Réduire les animations » de macOS ; on/off = choix forcé. */
export type MotionPreference = 'system' | 'on' | 'off'
export type ChatWidth = 'narrow' | 'wide'

/** Un réglage d'échantillonnage : désactivé = on laisse la valeur par défaut du fournisseur. */
export interface SamplingControl {
  enabled: boolean
  value: number
}

export interface Preferences {
  theme: ThemePreference
  motion: MotionPreference
  /** Largeur de la colonne de messages. */
  chatWidth: ChatWidth
  /** Envoyé en message « system » avant la conversation (vide = aucun). */
  systemPrompt: string
  temperature: SamplingControl
  topP: SamplingControl
  maxTokens: SamplingControl
  /** Nombre de messages envoyés au modèle (les plus récents). */
  historyLimit: number
  /** Demander au modèle un titre pour chaque nouvelle conversation (consomme une requête). */
  autoTitle: boolean
}

/** Bornes des réglages : les mêmes que le Playground de FreeLLMAPI. */
export const LIMITS = {
  temperature: { min: 0, max: 2, step: 0.1 },
  topP: { min: 0, max: 1, step: 0.05 },
  maxTokens: { min: 1, max: 1_000_000, step: 1 },
  historyLimit: { min: 2, max: 100, step: 2 },
} as const

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  motion: 'system',
  chatWidth: 'narrow',
  systemPrompt: '',
  temperature: { enabled: false, value: 1 },
  topP: { enabled: false, value: 1 },
  maxTokens: { enabled: false, value: 1024 },
  historyLimit: 20,
  autoTitle: true,
}

const STORAGE_KEY = 'freellm-chat:preferences'

// --- Validation : ce qui vient de localStorage peut être n'importe quoi ---------------

function clamp(n: unknown, min: number, max: number, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function readControl(raw: unknown, key: 'temperature' | 'topP' | 'maxTokens'): SamplingControl {
  const fallback = DEFAULT_PREFERENCES[key]
  if (typeof raw !== 'object' || raw === null) return fallback
  const r = raw as Partial<SamplingControl>
  const { min, max } = LIMITS[key]
  const value = clamp(r.value, min, max, fallback.value)
  return { enabled: r.enabled === true, value: key === 'maxTokens' ? Math.round(value) : value }
}

function sanitize(raw: unknown): Preferences {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFERENCES
  const r = raw as Record<string, unknown>
  const d = DEFAULT_PREFERENCES
  return {
    theme: r.theme === 'light' || r.theme === 'dark' || r.theme === 'system' ? r.theme : d.theme,
    motion:
      r.motion === 'system' || r.motion === 'on' || r.motion === 'off'
        ? r.motion
        : r.animations === false // ancienne version : un simple interrupteur
          ? 'off'
          : d.motion,
    chatWidth: r.chatWidth === 'wide' || r.chatWidth === 'narrow' ? r.chatWidth : d.chatWidth,
    systemPrompt: typeof r.systemPrompt === 'string' ? r.systemPrompt.slice(0, 20_000) : d.systemPrompt,
    temperature: readControl(r.temperature, 'temperature'),
    topP: readControl(r.topP, 'topP'),
    maxTokens: readControl(r.maxTokens, 'maxTokens'),
    historyLimit: Math.round(clamp(r.historyLimit, LIMITS.historyLimit.min, LIMITS.historyLimit.max, d.historyLimit)),
    autoTitle: typeof r.autoTitle === 'boolean' ? r.autoTitle : d.autoTitle,
  }
}

function load(): Preferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? sanitize(JSON.parse(raw)) : DEFAULT_PREFERENCES
  } catch {
    return DEFAULT_PREFERENCES // localStorage indisponible ou JSON abîmé
  }
}

// --- Le store ------------------------------------------------------------------------

let current = load()
const listeners = new Set<() => void>()

export function getPreferences(): Preferences {
  return current
}

export function setPreferences(patch: Partial<Preferences>): void {
  current = sanitize({ ...current, ...patch })
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current))
  } catch {
    // tant pis : le réglage marche quand même jusqu'à la fermeture de l'appli
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Une autre fenêtre/onglet de la même origine a modifié les préférences : on suit.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return
    current = load()
    for (const listener of listeners) listener()
  })
}

/** Les préférences dans un composant React (re-render quand elles changent). */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getPreferences)
}

/** Champs à ajouter à la requête /v1/chat/completions (seulement les réglages activés). */
export function samplingParams(p: Preferences): { temperature?: number; top_p?: number; max_tokens?: number } {
  return {
    ...(p.temperature.enabled && { temperature: p.temperature.value }),
    ...(p.topP.enabled && { top_p: p.topP.value }),
    ...(p.maxTokens.enabled && { max_tokens: p.maxTokens.value }),
  }
}

/** true si au moins un réglage du modèle s'écarte des valeurs par défaut (pour afficher un indicateur). */
export function hasCustomModelSettings(p: Preferences): boolean {
  return (
    p.systemPrompt.trim() !== '' ||
    p.temperature.enabled ||
    p.topP.enabled ||
    p.maxTokens.enabled ||
    p.historyLimit !== DEFAULT_PREFERENCES.historyLimit
  )
}
