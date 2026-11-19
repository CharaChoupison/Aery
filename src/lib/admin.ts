// Statistiques de FreeLLMAPI (lecture seule) : analytique, journaux, scores des modèles.
// Le navigateur appelle /admin/... ; notre proxy (plugin Vite ou Rust) y ajoute la session
// du dashboard FreeLLMAPI et ne laisse passer qu'une liste blanche de routes en GET.

import { ApiError } from './api'
import { appFetch, IS_TAURI } from './transport'

async function adminGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await appFetch(`/admin/${path}`, { signal })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e
    throw new ApiError(0, IS_TAURI ? 'Erreur interne de l’appli.' : 'Impossible de joindre le serveur local (npm run dev).')
  }
  if (!res.ok) {
    let message = `Erreur ${res.status}`
    try {
      const body = await res.json()
      message = body?.error?.message ?? message
    } catch {
      // pas du JSON
    }
    throw new ApiError(res.status, message)
  }
  return res.json() as Promise<T>
}

// --- Période ------------------------------------------------------------------

export type Range = '24h' | '7d' | '30d' | '90d' | 'all'

export const RANGES: { value: Range; label: string }[] = [
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 j' },
  { value: '30d', label: '30 j' },
  { value: '90d', label: '90 j' },
  { value: 'all', label: 'Depuis le début' },
]

// --- Analytique ---------------------------------------------------------------

export interface Summary {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  estimatedCostSavings: number
  firstRequestAt: string | null
  lifetimeTotalRequests: number
}

export interface TimelinePoint {
  timestamp: string // « 2026-11-19 » (par jour) ou « 2026-11-19T14:00:00 » (par heure)
  requests: number
  successCount: number
  failureCount: number
  inputTokens: number
  outputTokens: number
}

export interface ModelUsage {
  platform: string
  modelId: string
  displayName: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

export interface ErrorDistribution {
  byCategory: { category: string; count: number }[]
  byPlatform: { platform: string; endpoint: string; count: number }[]
}

export type RequestStatus = 'success' | 'error' | 'canceled'

export interface RequestRow {
  id: number
  platform: string
  modelId: string
  requestedModel: string | null
  requestType: string
  status: RequestStatus
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  error: string | null
  clientAgent: string | null
  createdAt: string
  attemptCount: number
}

export interface RequestDetail extends RequestRow {
  servedModel: string | null
  ttfbMs: number | null
  attempts: {
    ordinal: number
    platform: string
    modelId: string
    keyLabel: string | null
    outcome: string
    startOffsetMs: number | null
    durationMs: number | null
    errorSummary: string | null
  }[]
}

/** Décalage horaire en minutes (Paris l'hiver : +60), pour que les jours/heures soient les nôtres. */
const tzOffset = () => -new Date().getTimezoneOffset()

export const getSummary = (range: Range, signal?: AbortSignal) => adminGet<Summary>(`analytics/summary?range=${range}`, signal)

export const getTimeline = (range: Range, signal?: AbortSignal) =>
  adminGet<TimelinePoint[]>(`analytics/timeline?range=${range}&tzOffset=${tzOffset()}`, signal)

export const getByModel = (range: Range, signal?: AbortSignal) => adminGet<ModelUsage[]>(`analytics/by-model?range=${range}`, signal)

export const getErrorDistribution = (range: Range, signal?: AbortSignal) =>
  adminGet<ErrorDistribution>(`analytics/error-distribution?range=${range}`, signal)

export function getRequests(range: Range, options: { status?: RequestStatus; limit?: number; offset?: number } = {}, signal?: AbortSignal) {
  const params = new URLSearchParams({ range, limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) })
  if (options.status) params.set('status', options.status)
  return adminGet<{ total: number; rows: RequestRow[] }>(`analytics/requests?${params}`, signal)
}

export const getRequestDetail = (id: number, signal?: AbortSignal) => adminGet<RequestDetail>(`analytics/requests/${id}`, signal)

// --- Journaux du serveur ------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  ts: string
  level: LogLevel
  source?: string
  provider?: string
  model?: string
  event?: string
  message: string
}

export interface LogsResponse {
  entries: LogEntry[]
  nextId: number
  counts: Partial<Record<LogLevel, number>>
}

export function getLogs(options: { levels?: LogLevel[]; q?: string; limit?: number }, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(options.limit ?? 300) })
  if (options.levels?.length) params.set('levels', options.levels.join(','))
  if (options.q?.trim()) params.set('q', options.q.trim())
  return adminGet<LogsResponse>(`logs?${params}`, signal)
}

// --- Modèles (chaîne de repli + scores du routeur) ----------------------------

export interface ChainModel {
  modelDbId: number
  /** Même modèle servi par plusieurs fournisseurs = même groupe (ex. « llama 3.3 70b »). */
  groupKey?: string
  groupLabel?: string
  priority: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  sizeLabel: string | null
  rpmLimit: number | null
  rpdLimit: number | null
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  retiredUpstream: boolean
  /** Nombre de clés valides pour ce fournisseur : 0 = modèle inutilisable pour l'instant. */
  keyCount: number
}

export interface ModelScore {
  modelDbId: number
  reliability: number // 0 → 1
  speed: number
  intelligence: number
  score: number
  totalRequests: number
}

export interface Routing {
  strategy: string
  weights: { reliability: number; speed: number; intelligence: number }
  scores: ModelScore[]
}

export const getChain = (signal?: AbortSignal) => adminGet<ChainModel[]>('fallback', signal)
export const getRouting = (signal?: AbortSignal) => adminGet<Routing>('fallback/routing', signal)

/** Noms des stratégies de routage, comme dans le dashboard de FreeLLMAPI. */
export const STRATEGY_LABELS: Record<string, string> = {
  priority: 'Manuel',
  balanced: 'Équilibré',
  smartest: 'Le plus intelligent',
  fastest: 'Le plus rapide',
  reliable: 'Le plus fiable',
  custom: 'Personnalisé',
  decision: 'Decision',
}

// --- Mise en forme ------------------------------------------------------------

const fr = new Intl.NumberFormat('fr-FR')
const compact = new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: 1 })

export const formatNumber = (n: number) => fr.format(n)
export const formatCompact = (n: number) => compact.format(n)

/** 13403 → « 13,4 s », 850 → « 850 ms » */
export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '–'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`
}

/** 131072 → « 128k », 1048576 → « 1M » */
export function formatContext(tokens: number | null): string | null {
  if (!tokens) return null
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1024)}k`
}
