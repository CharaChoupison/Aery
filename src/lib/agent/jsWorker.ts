/**
 * Web Worker qui exécute le code JavaScript écrit par le modèle (outil run_js).
 *
 * Un worker tourne sur un fil à part, sans accès à la page (pas de DOM, pas de localStorage).
 * MAIS il garde l'origine de la page : sans précaution, il pourrait appeler notre proxy /v1 et
 * /admin (qui ajoutent la clé tout seuls !), lire l'historique dans IndexedDB ou envoyer des
 * données sur Internet. Donc, AVANT d'exécuter quoi que ce soit, on retire :
 *  - tout le réseau (fetch, XMLHttpRequest, WebSocket…) et le stockage (indexedDB, caches…) ;
 *  - toute façon de transformer du texte en code (eval, Function, setTimeout("…")), une fois le
 *    code du modèle compilé. Sans ça, il pourrait reconstruire un `import()` caché dans une chaîne ;
 *  - et sandbox.ts refuse tout code qui contient le mot « import » (le seul accès réseau qu'on ne
 *    peut pas supprimer). Si un verrou échoue, on refuse d'exécuter (on échoue « fermé »).
 *
 * Un worker neuf par exécution, tué après le délai : rien ne survit d'un appel à l'autre.
 * Ce fichier ne doit rien importer : il doit être autonome.
 */

const BLOCKED_GLOBALS = [
  'fetch',
  'fetchLater',
  'XMLHttpRequest',
  'WebSocket',
  'WebSocketStream',
  'WebTransport',
  'EventSource',
  'Worker',
  'SharedWorker',
  'importScripts',
  'indexedDB',
  'caches',
  'cookieStore',
  'BroadcastChannel',
  'Request', // inutile sans fetch, mais on ne laisse rien traîner
  'navigator',
]

/** Supprime une propriété de l'objet global ET de toute sa chaîne de prototypes. */
function removeGlobal(name: string): boolean {
  let obj: object | null = globalThis
  while (obj) {
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      try {
        delete (obj as Record<string, unknown>)[name]
      } catch {
        // propriété non supprimable : on tente de la masquer ci-dessous
      }
    }
    obj = Object.getPrototypeOf(obj)
  }
  try {
    Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false })
  } catch {
    // déjà verrouillée
  }
  return (globalThis as Record<string, unknown>)[name] === undefined
}

function lockNetwork(): boolean {
  return BLOCKED_GLOBALS.map(removeGlobal).every(Boolean)
}

/** Empêche de créer du code à partir de texte (à faire APRÈS avoir compilé le code du modèle). */
function lockCodeGeneration(): boolean {
  const refuse = () => {
    throw new Error('Génération de code désactivée dans le bac à sable.')
  }
  const constructors = [
    Function,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ] as { prototype: object }[]
  for (const C of constructors) {
    Object.defineProperty(C.prototype, 'constructor', { value: refuse, writable: false, configurable: false })
  }
  Object.defineProperty(globalThis, 'eval', { value: refuse, writable: false, configurable: false })
  Object.defineProperty(globalThis, 'Function', { value: refuse, writable: false, configurable: false })
  // setTimeout("code") évalue la chaîne : on n'accepte que des fonctions.
  for (const name of ['setTimeout', 'setInterval'] as const) {
    const original = globalThis[name].bind(globalThis) as (...args: unknown[]) => number
    Object.defineProperty(globalThis, name, {
      value: (fn: unknown, ...rest: unknown[]) => {
        if (typeof fn !== 'function') throw new Error(`${name} n’accepte qu’une fonction.`)
        return original(fn, ...rest)
      },
      writable: false,
      configurable: false,
    })
  }
  // oxlint-disable-next-line no-eval -- on vérifie justement que eval est désactivé
  return (() => {}).constructor === refuse && globalThis.eval === refuse
}

/** Transforme une valeur en texte lisible pour le modèle. */
function format(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (typeof value === 'function') return `[fonction ${value.name || 'anonyme'}]`
  if (typeof value === 'bigint') return `${value}n`
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (value instanceof Map) return `Map(${value.size}) ${format(Object.fromEntries(value))}`
  if (value instanceof Set) return `Set(${value.size}) ${format([...value])}`
  try {
    const seen = new WeakSet()
    return JSON.stringify(
      value,
      (_k, v: unknown) => {
        if (typeof v === 'bigint') return `${v}n`
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circulaire]'
          seen.add(v)
        }
        return v
      },
      2,
    )
  } catch {
    return String(value)
  }
}

const MAX_LOG = 20_000
const networkLocked = lockNetwork()
// Récupérés AVANT le verrouillage de la génération de code.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (
  ...args: unknown[]
) => Promise<unknown>
const post = globalThis.postMessage.bind(globalThis) as (message: unknown) => void

/**
 * Comme la console du navigateur : si le code finit par une simple expression (« total; »),
 * on la renvoie. Les modèles écrivent souvent ça et croient avoir affiché le résultat.
 * On essaie de compiler « …; return (total) » ; si ça ne compile pas, null (code d'origine).
 */
function compileWithLastExpression(code: string): ((...args: unknown[]) => Promise<unknown>) | null {
  const lines = code.trimEnd().split('\n')
  const last = lines.at(-1)?.trim().replace(/;+$/, '') ?? ''
  if (!last || /^(return|const|let|var|if|else|for|while|do|switch|try|catch|finally|function|class|throw|\/\/|\}|\{)\b/.test(last) || last.startsWith('}') || last.endsWith('{')) {
    return null
  }
  try {
    return new AsyncFunction('console', `"use strict";\n${lines.slice(0, -1).join('\n')}\nreturn (${last})`)
  } catch {
    return null
  }
}

globalThis.onmessage = async (event: MessageEvent<{ code: string }>) => {
  const logs: string[] = []
  let size = 0
  const push = (prefix: string, args: unknown[]) => {
    const line = prefix + args.map(format).join(' ')
    if (size > MAX_LOG) return
    size += line.length
    logs.push(line)
  }
  const sandboxConsole = {
    log: (...a: unknown[]) => push('', a),
    info: (...a: unknown[]) => push('', a),
    debug: (...a: unknown[]) => push('', a),
    warn: (...a: unknown[]) => push('[avertissement] ', a),
    error: (...a: unknown[]) => push('[erreur] ', a),
    table: (...a: unknown[]) => push('', a),
  }

  if (!networkLocked) {
    post({ ok: false, error: 'Bac à sable incomplet (réseau non bloqué) : exécution refusée.', logs })
    return
  }

  let fn: (...args: unknown[]) => Promise<unknown>
  try {
    // « console » en paramètre : le code du modèle utilise notre console, pas celle du navigateur.
    fn = compileWithLastExpression(event.data.code) ?? new AsyncFunction('console', '"use strict";\n' + event.data.code)
  } catch (e) {
    post({ ok: false, error: `Erreur de syntaxe : ${(e as Error).message}`, logs })
    return
  }
  if (!lockCodeGeneration()) {
    post({ ok: false, error: 'Bac à sable incomplet : exécution refusée.', logs })
    return
  }

  try {
    const result = await fn(sandboxConsole)
    post({ ok: true, result: result === undefined ? undefined : format(result), logs })
  } catch (e) {
    post({ ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : format(e), logs })
  }
}
