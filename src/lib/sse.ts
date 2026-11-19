/**
 * Lecteur SSE (Server-Sent Events) minimal.
 *
 * Le serveur envoie du texte comme :
 *   data: {"choices":[{"delta":{"content":"Bon"}}]}
 *   data: {"choices":[{"delta":{"content":"jour"}}]}
 *   data: [DONE]
 *
 * Piège : le réseau découpe ce texte n'importe où, parfois au milieu d'une ligne.
 * On accumule donc dans un tampon et on ne traite que les lignes COMPLÈTES.
 *
 * Ce générateur renvoie le contenu de chaque ligne « data: » (sans le préfixe).
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder() // gère aussi les accents coupés entre deux morceaux
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? '' // le dernier bout est peut-être incomplet : on le garde pour plus tard

      for (const line of lines) {
        const data = parseDataLine(line)
        if (data !== null) yield data
      }
    }

    // Fin du flux : on traite ce qui reste dans le tampon.
    buffer += decoder.decode()
    const data = parseDataLine(buffer)
    if (data !== null) yield data
  } finally {
    // Si on s'arrête avant la fin (ex. [DONE] reçu, ou erreur), on libère le flux.
    reader.cancel().catch(() => {})
  }
}

/** « data: xyz » → « xyz ». Les autres lignes (vides, commentaires « : ping », event:…) → null. */
function parseDataLine(line: string): string | null {
  if (!line.startsWith('data:')) return null
  const value = line.slice(5)
  return value.startsWith(' ') ? value.slice(1) : value
}
