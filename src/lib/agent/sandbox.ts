/**
 * Outil run_js : exécute du JavaScript dans un Web Worker isolé (voir jsWorker.ts pour les verrous).
 * Un worker neuf à chaque appel, tué après RUN_TIMEOUT ou si l'utilisateur clique sur Stop.
 */

export const RUN_TIMEOUT = 5_000
const MAX_CODE = 50_000

interface WorkerReply {
  ok: boolean
  result?: string
  error?: string
  logs: string[]
}

/**
 * Le seul accès réseau qu'un worker garde toujours : `import()`. On refuse donc le mot « import »
 * partout (même dans une chaîne ou un commentaire : tant pis pour les faux positifs, c'est plus sûr).
 */
export function forbiddenReason(code: string): string | null {
  if (code.length > MAX_CODE) return `Code trop long (${MAX_CODE} caractères maximum).`
  if (/\bimport\b/.test(code)) return '« import » est interdit : aucun module ni réseau n’est disponible dans le bac à sable.'
  return null
}

/** Exécute le code et renvoie le texte à donner au modèle (console + valeur renvoyée). */
export function runJs(code: string, signal?: AbortSignal): Promise<string> {
  const refused = forbiddenReason(code)
  if (refused) return Promise.reject(new Error(refused))

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./jsWorker.ts', import.meta.url), { type: 'module', name: 'run_js' })
    const finish = (fn: () => void) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      worker.terminate()
      fn()
    }
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Délai dépassé : le code a tourné plus de ${RUN_TIMEOUT / 1000} s (boucle infinie ?).`))),
      RUN_TIMEOUT,
    )
    const onAbort = () => finish(() => reject(new DOMException('Exécution annulée', 'AbortError')))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const { ok, result, error, logs } = event.data
      const parts = [
        logs.length > 0 && `Console :\n${logs.join('\n')}`,
        ok && result !== undefined && `Valeur renvoyée : ${result}`,
      ].filter(Boolean)
      const nothing = 'Exécuté sans erreur, mais rien affiché ni renvoyé. Utilise console.log(…) ou termine par « return valeur ».'
      if (ok) finish(() => resolve(parts.join('\n\n') || nothing))
      else finish(() => reject(new Error([error, ...parts].join('\n\n'))))
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(() => reject(new Error(event.message || 'Le bac à sable a planté.')))
    }
    worker.postMessage({ code })
  })
}
