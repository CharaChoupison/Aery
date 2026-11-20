import { Channel, invoke, isTauri } from '@tauri-apps/api/core'

/** true dans l'appli Tauri, false dans le navigateur (npm run dev). */
export const IS_TAURI = isTauri()

/** Événements envoyés par la partie Rust (src-tauri/src/proxy.rs). */
type ProxyEvent =
  | { type: 'head'; status: number; headers: [string, string][] }
  | { type: 'chunk'; data: number[] }
  | { type: 'end' }
  | { type: 'error'; message: string }

interface AppFetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: string
  signal?: AbortSignal
}

let nextId = 1

/**
 * Comme fetch(), mais qui marche aussi dans l'appli Tauri.
 *  - Navigateur : fetch() vers notre serveur Vite (qui ajoute la clé).
 *  - Appli : la partie Rust fait la requête (et ajoute la clé lue dans le Trousseau),
 *    puis nous renvoie la réponse morceau par morceau. On reconstruit un vrai objet
 *    Response : le reste du code (lecteur SSE, erreurs…) ne voit aucune différence.
 */
export function appFetch(path: string, init: AppFetchInit = {}): Promise<Response> {
  if (!IS_TAURI) {
    return fetch(path, {
      method: init.method ?? 'GET',
      body: init.body,
      signal: init.signal,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    })
  }

  return new Promise<Response>((resolve, reject) => {
    const id = nextId++
    const { signal } = init
    let settled = false // la Response a-t-elle déjà été renvoyée ?
    let controller!: ReadableStreamDefaultController<Uint8Array>

    const cancel = () => void invoke('cancel_request', { id }).catch(() => {})

    // Le corps de la réponse : un flux qu'on remplit avec les morceaux venus de Rust.
    const body = new ReadableStream<Uint8Array>({
      start: (c) => {
        controller = c
      },
      cancel, // le lecteur arrête de lire → on coupe côté Rust aussi
    })

    const fail = (error: Error) => {
      if (!settled) {
        settled = true
        reject(error)
      } else {
        try {
          controller.error(error)
        } catch {
          // flux déjà fermé
        }
      }
    }

    const channel = new Channel<ProxyEvent>()
    channel.onmessage = (event) => {
      switch (event.type) {
        case 'head':
          settled = true
          resolve(new Response(body, { status: event.status, headers: event.headers }))
          break
        case 'chunk':
          controller.enqueue(new Uint8Array(event.data))
          break
        case 'end':
          controller.close()
          break
        case 'error':
          fail(new TypeError(event.message))
          break
      }
    }

    // Bouton Stop / délai dépassé : même comportement que fetch() (AbortError).
    const onAbort = () => {
      cancel()
      fail(new DOMException('Requête annulée', 'AbortError'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    invoke('proxy_request', {
      request: { id, method: init.method ?? 'GET', path, body: init.body ?? null },
      onEvent: channel,
    }).catch((e) => fail(new TypeError(String(e))))
  })
}

/** Appel d'une commande Rust ; les erreurs (des chaînes) deviennent des Error. */
export async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (e) {
    throw new Error(typeof e === 'string' ? e : 'Erreur de l’appli')
  }
}
