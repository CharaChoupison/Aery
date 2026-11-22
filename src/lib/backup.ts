import { mergeTables, readAllTables, type BackupTables, type MergeCount } from './db'
import { getPreferences, setPreferences, type Preferences } from './preferences'
import { IS_TAURI, invokeCommand } from './transport'

/**
 * Sauvegarde complète d'Aery dans UN fichier JSON : conversations, projets, second cerveau
 * (+ versions et rangements) et préférences. Jamais la clé FreeLLMAPI (elle n'est pas ici).
 *
 * Pourquoi : tout vit dans IndexedDB, liée à l'origine de la page. Si WebKit vide ses données,
 * ou si l'appli change d'identifiant, tout part. Ce fichier, on peut le ranger où on veut.
 *
 * L'import FUSIONNE (voir `mergeTables`) : il n'efface rien et ne remplace un élément que par une
 * version plus récente. Les dossiers (`workspace`, `folder`) restent de simples chemins : ils ne
 * donnent aucun accès, l'appli ne lit un dossier qu'après l'avoir choisi dans la fenêtre macOS.
 */

const FORMAT = 1
const APP = 'aery'
const LAST_BACKUP_KEY = 'freellm-chat:last-backup'
/** Au-delà, on refuse : c'est sûrement le mauvais fichier (et le navigateur souffrirait). */
export const MAX_BACKUP_BYTES = 500 * 1024 * 1024

export interface Backup extends BackupTables {
  app: typeof APP
  format: typeof FORMAT
  exportedAt: number
  preferences: Preferences
}

export type ImportReport = Record<keyof BackupTables, MergeCount> & { preferences: boolean }

// --- Export ------------------------------------------------------------------------------

export async function createBackup(): Promise<Backup> {
  return { app: APP, format: FORMAT, exportedAt: Date.now(), preferences: getPreferences(), ...(await readAllTables()) }
}

export function backupFileName(at = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `aery-sauvegarde-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`
}

/**
 * Exporte et enregistre le fichier. Appli : fenêtre « Enregistrer » de macOS (côté Rust).
 * Web : téléchargement classique. Renvoie false si l'utilisateur a annulé.
 */
export async function saveBackup(): Promise<boolean> {
  const backup = await createBackup()
  const json = JSON.stringify(backup)
  const name = backupFileName()
  if (IS_TAURI) {
    const path = await invokeCommand<string | null>('save_backup', { name, contents: json })
    if (path === null) return false
  } else {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    // Laisse le temps au navigateur de lancer le téléchargement avant de libérer le fichier.
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  setLastBackupAt(backup.exportedAt)
  return true
}

export function getLastBackupAt(): number | null {
  try {
    const n = Number(localStorage.getItem(LAST_BACKUP_KEY))
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function setLastBackupAt(at: number): void {
  try {
    localStorage.setItem(LAST_BACKUP_KEY, String(at))
  } catch {
    // pas grave : seul le rappel « dernière sauvegarde » est perdu
  }
}

// --- Import : le fichier peut contenir n'importe quoi, on vérifie tout -------------------

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)

function hasBase(r: Rec, time: 'updatedAt' | 'savedAt' | 'at'): boolean {
  return isStr(r.id) && r.id.length > 0 && r.id.length <= 200 && isNum(r[time])
}

function isMessage(m: unknown): boolean {
  return isRec(m) && isStr(m.id) && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && isStr(m.content)
}

function isConversation(c: unknown): boolean {
  return isRec(c) && hasBase(c, 'updatedAt') && isStr(c.title) && isNum(c.createdAt) && Array.isArray(c.messages) && c.messages.every(isMessage)
}

function isProject(p: unknown): boolean {
  return isRec(p) && hasBase(p, 'updatedAt') && isStr(p.name) && isStr(p.instructions) && isNum(p.createdAt)
}

const BRAIN_KINDS = new Set(['note', 'reply', 'file', 'web'])
function isBrainItem(i: unknown): boolean {
  return (
    isRec(i) &&
    hasBase(i, 'updatedAt') &&
    isStr(i.kind) &&
    BRAIN_KINDS.has(i.kind) &&
    isStr(i.title) &&
    isStr(i.content) &&
    isStrArray(i.tags) &&
    isStrArray(i.projectIds) &&
    isNum(i.createdAt)
  )
}

function isBrainVersion(v: unknown): boolean {
  return isRec(v) && hasBase(v, 'savedAt') && isStr(v.itemId) && isBrainItem(v.item)
}

function isTidyRun(r: unknown): boolean {
  return isRec(r) && hasBase(r, 'at') && isStr(r.status)
}

export class BackupError extends Error {}

/** Lit et vérifie un fichier de sauvegarde. Lance une BackupError lisible si quelque chose cloche. */
export function parseBackup(text: string): Backup {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('Ce fichier n’est pas du JSON valide.')
  }
  if (!isRec(raw) || raw.app !== APP) throw new BackupError('Ce fichier n’est pas une sauvegarde d’Aery.')
  if (raw.format !== FORMAT) {
    throw new BackupError(
      isNum(raw.format) && raw.format > FORMAT
        ? 'Cette sauvegarde vient d’une version plus récente d’Aery : mets l’appli à jour d’abord.'
        : 'Format de sauvegarde inconnu.',
    )
  }
  const tables: [keyof BackupTables, (v: unknown) => boolean, string][] = [
    ['conversations', isConversation, 'une conversation'],
    ['projects', isProject, 'un projet'],
    ['brain', isBrainItem, 'un élément du cerveau'],
    ['brainVersions', isBrainVersion, 'une version d’élément'],
    ['tidyRuns', isTidyRun, 'un rangement'],
  ]
  for (const [key, check, label] of tables) {
    const rows = raw[key]
    if (!Array.isArray(rows)) throw new BackupError(`Sauvegarde incomplète : « ${key} » manque.`)
    const bad = rows.findIndex((r) => !check(r))
    if (bad !== -1) throw new BackupError(`Sauvegarde abîmée : ${label} (n° ${bad + 1}) est mal formé(e).`)
  }
  return {
    ...(raw as unknown as Backup),
    exportedAt: isNum(raw.exportedAt) ? raw.exportedAt : 0,
    preferences: (isRec(raw.preferences) ? raw.preferences : {}) as unknown as Preferences,
  }
}

/** Fusionne la sauvegarde dans la base (et, si demandé, remplace les préférences). */
export async function importBackup(backup: Backup, options: { preferences: boolean }): Promise<ImportReport> {
  const counts = await mergeTables(backup)
  // setPreferences revalide chaque champ : une valeur inconnue retombe sur la valeur par défaut.
  if (options.preferences) setPreferences(backup.preferences)
  return { ...counts, preferences: options.preferences }
}

export function backupSummary(b: BackupTables): string {
  const parts: [number, string, string][] = [
    [b.conversations.length, 'conversation', 'conversations'],
    [b.projects.length, 'projet', 'projets'],
    [b.brain.length, 'élément du cerveau', 'éléments du cerveau'],
  ]
  return parts.map(([n, one, many]) => `${n} ${n > 1 ? many : one}`).join(', ')
}
