/**
 * Pièces jointes du chat : images (pour les modèles « vision ») et fichiers texte (code, Markdown, CSV…).
 *
 * Tout se passe dans la page : rien n'est envoyé avant le message.
 *  - Une image est réduite (1600 px max) et réencodée si elle est lourde, puis gardée en « data URL »
 *    (base64). C'est le format attendu par l'API OpenAI : { type: 'image_url', image_url: { url } }.
 *  - Un fichier texte est lu en entier et ajouté au message, entre balises <fichier>.
 * PDF, Word… : pas encore (il faudrait extraire leur texte).
 */

export interface Attachment {
  id: string
  kind: 'image' | 'text'
  name: string
  mimeType: string
  /** Taille du fichier d'origine, en octets. */
  size: number
  /** Image : data URL (éventuellement compressée). */
  dataUrl?: string
  /** Fichier texte : son contenu. */
  text?: string
}

export const MAX_ATTACHMENTS = 6
export const MAX_IMAGES = 4
const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // fichier d'origine
const MAX_TEXT_BYTES = 512 * 1024
const MAX_SIDE = 1600 // px
const KEEP_AS_IS_BYTES = 800 * 1024 // en dessous, une image JPEG/PNG/WebP est envoyée telle quelle

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Pour l'attribut accept du sélecteur de fichiers (le glisser-déposer accepte tout ce qui est du texte). */
export const ACCEPT = [
  ...IMAGE_TYPES,
  'text/*',
  '.md,.markdown,.txt,.csv,.tsv,.json,.jsonc,.yaml,.yml,.toml,.xml,.html,.css,.scss',
  '.js,.jsx,.ts,.tsx,.mjs,.cjs,.vue,.svelte,.py,.rb,.php,.java,.kt,.swift,.go,.rs,.c,.h,.cpp,.hpp,.cs',
  '.sh,.zsh,.sql,.graphql,.env.example,.ini,.cfg,.conf,.log,.tex,.srt',
].join(',')

export class AttachmentError extends Error {}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} Ko`
  return `${(bytes / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`
}

export async function readAttachment(file: File): Promise<Attachment> {
  const base = { id: crypto.randomUUID(), name: file.name || 'sans-nom', size: file.size }
  if (IMAGE_TYPES.includes(file.type)) {
    if (file.size > MAX_IMAGE_BYTES) throw new AttachmentError(`« ${base.name} » est trop lourde (20 Mo maximum).`)
    const { dataUrl, mimeType } = await prepareImage(file)
    return { ...base, kind: 'image', mimeType, dataUrl }
  }
  if (file.type.startsWith('image/')) {
    throw new AttachmentError(`« ${base.name} » : format d’image non pris en charge (PNG, JPEG, WebP ou GIF).`)
  }
  if (file.size > MAX_TEXT_BYTES) {
    throw new AttachmentError(`« ${base.name} » est trop gros (${formatSize(MAX_TEXT_BYTES)} maximum pour un fichier texte).`)
  }
  const text = decodeText(new Uint8Array(await file.arrayBuffer()))
  if (text === null) {
    throw new AttachmentError(`« ${base.name} » n’est pas un fichier texte. Pour l’instant : images et fichiers texte (code, Markdown, CSV…).`)
  }
  return { ...base, kind: 'text', mimeType: file.type || 'text/plain', text }
}

/** UTF-8, sinon Windows-1252 (vieux fichiers). null = fichier binaire (PDF, Word, zip…). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.subarray(0, 8000).includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new AttachmentError('Lecture du fichier impossible.'))
    reader.readAsDataURL(blob)
  })
}

/** Réduit l'image si besoin. Les petites images (et les GIF, pour garder l'animation) passent telles quelles. */
async function prepareImage(file: File): Promise<{ dataUrl: string; mimeType: string }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new AttachmentError(`« ${file.name} » : image illisible.`)
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  if ((scale === 1 && file.size <= KEEP_AS_IS_BYTES) || file.type === 'image/gif') {
    bitmap.close()
    return { dataUrl: await readAsDataUrl(file), mimeType: file.type }
  }

  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new AttachmentError('Compression de l’image impossible.')
  // Fond blanc : le JPEG n'a pas de transparence (sinon les zones transparentes deviennent noires).
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), mimeType: 'image/jpeg' }
}

// --- Pour la requête envoyée au modèle ------------------------------------------------

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** Le texte du message + le contenu des fichiers texte joints. */
export function textWithFiles(content: string, attachments: Attachment[] = []): string {
  const files = attachments
    .filter((a) => a.kind === 'text')
    .map((a) => `<fichier nom="${a.name.replace(/["<>]/g, '')}">\n${a.text ?? ''}\n</fichier>`)
  return [content, ...files].filter(Boolean).join('\n\n')
}

/**
 * Contenu au format OpenAI. Avec des images : un tableau [texte, image, image…].
 * includeImages = false : les images sont remplacées par une mention (anciens messages, pour alléger la requête).
 */
export function toContent(content: string, attachments: Attachment[] = [], includeImages = true): string | ContentPart[] {
  const text = textWithFiles(content, attachments)
  const images = attachments.filter((a) => a.kind === 'image' && a.dataUrl)
  if (!images.length) return text
  if (!includeImages) return [text, ...images.map((a) => `[Image jointe : ${a.name}]`)].filter(Boolean).join('\n')
  return [
    { type: 'text', text: text || 'Voici l’image.' },
    ...images.map((a) => ({ type: 'image_url' as const, image_url: { url: a.dataUrl! } })),
  ]
}

export const hasImages = (attachments?: Attachment[]) => attachments?.some((a) => a.kind === 'image') ?? false
