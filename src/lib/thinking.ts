/**
 * Certains modèles écrivent leur réflexion DANS la réponse, entre balises :
 *   <think>je dois d'abord…</think>Voici la réponse.
 * On sépare les deux pour afficher la réflexion à part (et ne pas la renvoyer au modèle).
 */
export function splitThinking(content: string): { thinking: string; answer: string } {
  const match = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(content)
  if (!match) return { thinking: '', answer: content }
  const closed = match[2] === '</think>'
  return {
    thinking: match[1].trim(),
    // Balise pas encore fermée (streaming en cours) : pas encore de réponse.
    answer: closed ? content.slice(match[0].length).trimStart() : '',
  }
}
