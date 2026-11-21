import { fold, itemTitle, wikilinkTargets, type BrainItem, type BrainKind } from './brain'

/**
 * Vue « graphe » du second cerveau (façon Obsidian) : purement décorative, rien n'est stocké.
 *
 * Nœuds = éléments du cerveau (+ tags partagés si on les affiche), arêtes = liens (`links` et
 * [[…]]) et appartenance à un tag. Les positions viennent d'une petite simulation physique
 * faite main : les nœuds se repoussent, les arêtes sont des ressorts, et une légère gravité
 * garde le tout au centre. `alpha` (la « température ») baisse à chaque tour jusqu'à l'arrêt.
 */

export type GraphNodeKind = BrainKind | 'tag'

export interface GraphNode {
  /** Id de l'élément du cerveau, ou `tag:<nom>`. */
  id: string
  kind: GraphNodeKind
  label: string
  degree: number
  x: number
  y: number
  vx: number
  vy: number
  /** Tenu par la souris : la simulation ne le bouge pas. */
  fixed?: boolean
}

export interface GraphEdge {
  source: number
  target: number
  kind: 'link' | 'tag'
}

export interface BrainGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** Voisins de chaque nœud (indices), pour la mise en évidence au survol. */
  neighbors: Set<number>[]
}

/** Un tag porté par un seul élément n'apporte aucun lien : on ne l'affiche pas. */
const MIN_TAG_USES = 2

export function buildBrainGraph(items: BrainItem[], { tags }: { tags: boolean }): BrainGraph {
  const nodes: GraphNode[] = []
  const index = new Map<string, number>()
  const addNode = (id: string, kind: GraphNodeKind, label: string) => {
    index.set(id, nodes.length)
    nodes.push({ id, kind, label, degree: 0, x: 0, y: 0, vx: 0, vy: 0 })
  }
  for (const item of items) addNode(item.id, item.kind, itemTitle(item))

  const byTitle = new Map<string, string>()
  for (const item of items) {
    const t = fold(itemTitle(item))
    if (!byTitle.has(t)) byTitle.set(t, item.id)
  }

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  const addEdge = (a: string, b: string, kind: GraphEdge['kind']) => {
    const source = index.get(a)
    const target = index.get(b)
    if (source === undefined || target === undefined || source === target) return
    const key = source < target ? `${source}|${target}` : `${target}|${source}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ source, target, kind })
  }

  for (const item of items) {
    for (const id of item.links ?? []) addEdge(item.id, id, 'link')
    for (const title of wikilinkTargets(item.content)) {
      const id = byTitle.get(fold(title.trim()))
      if (id) addEdge(item.id, id, 'link')
    }
  }

  if (tags) {
    const uses = new Map<string, number>()
    for (const item of items) for (const t of item.tags) uses.set(t, (uses.get(t) ?? 0) + 1)
    for (const [t, n] of uses) if (n >= MIN_TAG_USES) addNode(`tag:${t}`, 'tag', `#${t}`)
    for (const item of items) for (const t of item.tags) addEdge(item.id, `tag:${t}`, 'tag')
  }

  const neighbors = nodes.map(() => new Set<number>())
  for (const e of edges) {
    nodes[e.source].degree++
    nodes[e.target].degree++
    neighbors[e.source].add(e.target)
    neighbors[e.target].add(e.source)
  }

  // Départ en spirale (tournesol) : déterministe et déjà bien réparti, la simulation converge vite.
  const golden = Math.PI * (3 - Math.sqrt(5))
  nodes.forEach((n, i) => {
    const r = 14 * Math.sqrt(i + 0.5)
    n.x = r * Math.cos(i * golden)
    n.y = r * Math.sin(i * golden)
  })

  return { nodes, edges, neighbors }
}

/** Rayon affiché d'un nœud : grossit avec le nombre de liens. */
export function nodeRadius(n: GraphNode): number {
  return n.kind === 'tag' ? 2.5 + Math.sqrt(n.degree) * 0.8 : 4 + Math.sqrt(n.degree) * 1.6
}

export const ALPHA_MIN = 0.004
const REPULSION = 2200
const LINK_LENGTH = { link: 80, tag: 60 }
const SPRING = 0.04
const GRAVITY = 0.012
const DECAY = 0.6

/** Un tour de simulation. Renvoie la nouvelle température. */
export function tick({ nodes, edges }: BrainGraph, alpha: number): number {
  const n = nodes.length
  // Répulsion entre toutes les paires (O(n²) : largement assez pour quelques centaines de notes).
  for (let i = 0; i < n; i++) {
    const a = nodes[i]
    for (let j = i + 1; j < n; j++) {
      const b = nodes[j]
      let dx = b.x - a.x
      let dy = b.y - a.y
      let d2 = dx * dx + dy * dy
      if (d2 < 1) {
        dx = (i - j) * 0.1 || 0.1
        dy = 0.1
        d2 = 1
      }
      if (d2 > 160_000) continue // au-delà de 400 px, l'effet est négligeable
      const f = (REPULSION * alpha) / d2
      const d = Math.sqrt(d2)
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx -= fx
      a.vy -= fy
      b.vx += fx
      b.vy += fy
    }
  }
  // Ressorts.
  for (const e of edges) {
    const a = nodes[e.source]
    const b = nodes[e.target]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const d = Math.sqrt(dx * dx + dy * dy) || 1
    const f = ((d - LINK_LENGTH[e.kind]) / d) * SPRING * alpha
    a.vx += dx * f
    a.vy += dy * f
    b.vx -= dx * f
    b.vy -= dy * f
  }
  for (const node of nodes) {
    if (node.fixed) {
      node.vx = node.vy = 0
      continue
    }
    node.vx = (node.vx - node.x * GRAVITY * alpha) * DECAY
    node.vy = (node.vy - node.y * GRAVITY * alpha) * DECAY
    node.x += node.vx
    node.y += node.vy
  }
  return alpha + (0 - alpha) * 0.0228
}

/** Fait tourner la simulation jusqu'au repos d'un coup (animations désactivées). */
export function settle(graph: BrainGraph, alpha = 1): void {
  while (alpha > ALPHA_MIN) alpha = tick(graph, alpha)
}

/** Nœud sous un point (coordonnées du graphe), en tolérant quelques pixels autour. */
export function nodeAt({ nodes }: BrainGraph, x: number, y: number, slack: number): number {
  let best = -1
  let bestD = Infinity
  nodes.forEach((n, i) => {
    const d = Math.hypot(n.x - x, n.y - y)
    if (d <= nodeRadius(n) + slack && d < bestD) {
      best = i
      bestD = d
    }
  })
  return best
}
