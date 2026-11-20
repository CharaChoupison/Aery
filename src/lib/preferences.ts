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

/** Plus / moins qu'à l'ordinaire (chaleur, enthousiasme, émojis, titres et listes). */
export type Level = 'default' | 'more' | 'less'
export type BaseStyle = 'default' | 'efficient' | 'detailed' | 'teacher' | 'casual' | 'professional'
/** Tutoyer ou vouvoyer l'utilisateur. */
export type Address = 'default' | 'tu' | 'vous'

/** Profil et personnalité, façon « Personnalisation » de ChatGPT. Ajouté au prompt système. */
export interface Profile {
  /** Interrupteur général : désactivé, rien de tout ça n'est envoyé. */
  enabled: boolean
  name: string
  pronouns: string
  address: Address
  occupation: string
  about: string
  style: BaseStyle
  warmth: Level
  enthusiasm: Level
  emojis: Level
  formatting: Level
}

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
  /** Instructions personnalisées, envoyées en message « system » avant la conversation (vide = aucune). */
  systemPrompt: string
  profile: Profile
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

export const DEFAULT_PROFILE: Profile = {
  enabled: true,
  name: '',
  pronouns: '',
  address: 'default',
  occupation: '',
  about: '',
  style: 'default',
  warmth: 'default',
  enthusiasm: 'default',
  emojis: 'default',
  formatting: 'default',
}

export const DEFAULT_PREFERENCES: Preferences = {
  theme: 'system',
  motion: 'system',
  chatWidth: 'narrow',
  systemPrompt: '',
  profile: DEFAULT_PROFILE,
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

const text = (v: unknown, max: number, fallback: string) => (typeof v === 'string' ? v.slice(0, max) : fallback)
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T =>
  values.includes(v as T) ? (v as T) : fallback
const LEVELS = ['default', 'more', 'less'] as const

function readProfile(raw: unknown): Profile {
  const d = DEFAULT_PROFILE
  if (typeof raw !== 'object' || raw === null) return d
  const r = raw as Record<string, unknown>
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    name: text(r.name, 60, d.name),
    pronouns: text(r.pronouns, 40, d.pronouns),
    address: oneOf(r.address, ['default', 'tu', 'vous'] as const, d.address),
    occupation: text(r.occupation, 100, d.occupation),
    about: text(r.about, 2000, d.about),
    style: oneOf(r.style, ['default', 'efficient', 'detailed', 'teacher', 'casual', 'professional'] as const, d.style),
    warmth: oneOf(r.warmth, LEVELS, d.warmth),
    enthusiasm: oneOf(r.enthusiasm, LEVELS, d.enthusiasm),
    emojis: oneOf(r.emojis, LEVELS, d.emojis),
    formatting: oneOf(r.formatting, LEVELS, d.formatting),
  }
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
    profile: readProfile(r.profile),
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

// --- Prompt système construit à partir du profil ---------------------------------------

const STYLE_TEXT: Record<Exclude<BaseStyle, 'default'>, string> = {
  efficient: 'Va droit au but : réponses courtes, précises, sans détour ni formule de politesse superflue.',
  detailed: 'Donne des réponses complètes et approfondies, avec le contexte et les nuances utiles.',
  teacher: 'Adopte une approche pédagogique : explique les notions pas à pas, avec des exemples concrets.',
  casual: 'Adopte un ton décontracté et naturel, comme une discussion entre amis.',
  professional: 'Adopte un ton professionnel, clair et soigné.',
}

const LEVEL_TEXT: Record<'warmth' | 'enthusiasm' | 'emojis' | 'formatting', Record<'more' | 'less', string>> = {
  warmth: { more: 'Sois chaleureux et bienveillant.', less: 'Reste neutre et factuel, sans effusions.' },
  enthusiasm: { more: 'Montre de l’enthousiasme et de l’énergie.', less: 'Garde un ton posé, sans enthousiasme excessif.' },
  emojis: { more: 'Utilise volontiers des émojis.', less: 'N’utilise pas d’émojis.' },
  formatting: {
    more: 'Structure tes réponses avec des titres et des listes à puces.',
    less: 'Écris surtout en paragraphes, avec peu de titres et de listes à puces.',
  },
}

/**
 * Le message « system » envoyé avant chaque conversation : profil + personnalité + instructions.
 * Vide si rien n'est renseigné (aucun message système n'est alors envoyé).
 */
export function buildSystemPrompt(p: Preferences): string {
  const parts: string[] = []
  const pr = p.profile
  if (pr.enabled) {
    const about: string[] = []
    if (pr.name.trim()) about.push(`Appelle l’utilisateur « ${pr.name.trim()} ».`)
    if (pr.pronouns.trim()) about.push(`Ses pronoms : ${pr.pronouns.trim()} (utilise-les quand tu parles de cette personne).`)
    if (pr.address === 'tu') about.push('Tutoie l’utilisateur.')
    if (pr.address === 'vous') about.push('Vouvoie l’utilisateur.')
    if (pr.occupation.trim()) about.push(`Son métier ou ses études : ${pr.occupation.trim()}.`)
    if (pr.about.trim()) about.push(`Ce qu’il faut savoir sur l’utilisateur :\n${pr.about.trim()}`)
    if (about.length) parts.push(`# À propos de l’utilisateur\n${about.join('\n')}`)

    const style: string[] = []
    if (pr.style !== 'default') style.push(STYLE_TEXT[pr.style])
    for (const key of ['warmth', 'enthusiasm', 'emojis', 'formatting'] as const) {
      const level = pr[key]
      if (level !== 'default') style.push(LEVEL_TEXT[key][level])
    }
    if (style.length) parts.push(`# Style de réponse\n${style.join('\n')}`)
  }
  if (p.systemPrompt.trim()) parts.push(`# Instructions de l’utilisateur\n${p.systemPrompt.trim()}`)
  return parts.join('\n\n')
}

/** true si au moins un réglage du modèle s'écarte des valeurs par défaut (pour afficher un indicateur). */
export function hasCustomModelSettings(p: Preferences): boolean {
  return (
    buildSystemPrompt(p) !== '' ||
    p.temperature.enabled ||
    p.topP.enabled ||
    p.maxTokens.enabled ||
    p.historyLimit !== DEFAULT_PREFERENCES.historyLimit
  )
}
