import { Hash, LocateFixed } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BRAIN_KIND_ICONS } from '@/components/brain/kinds'
import { Button } from '@/components/ui/button'
import { BRAIN_KIND_LABELS, type BrainItem, type BrainKind } from '@/lib/brain'
import { ALPHA_MIN, buildBrainGraph, nodeAt, nodeRadius, settle, tick, type BrainGraph, type GraphNodeKind } from '@/lib/brainGraph'
import { useMotion } from '@/lib/motion'
import { cn } from '@/lib/utils'

/** Couleur de chaque type de nœud (variables du thème, voir index.css). */
const KIND_COLORS: Record<GraphNodeKind, string> = {
  note: '--viz-1',
  reply: '--viz-7',
  file: '--viz-2',
  web: '--viz-3',
  tag: '--muted-foreground',
}
const KINDS: BrainKind[] = ['note', 'reply', 'file', 'web']
const MIN_ZOOM = 0.2
const MAX_ZOOM = 4
/** Au-delà de ce zoom, tous les titres s'affichent. */
const LABEL_ZOOM = 1.5

type Palette = Record<GraphNodeKind | 'edge' | 'label' | 'ring', string> & { font: string }

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    ...(Object.fromEntries(Object.entries(KIND_COLORS).map(([k, name]) => [k, v(name)])) as Record<GraphNodeKind, string>),
    edge: v('--muted-foreground'),
    label: v('--foreground'),
    ring: v('--background'),
    font: getComputedStyle(document.body).fontFamily,
  }
}

/**
 * Graphe du second cerveau dessiné sur un canvas : survol = la note et ses voisins ressortent,
 * clic = ouvre la note, glisser un nœud = le déplacer, glisser le fond = se déplacer, molette = zoom.
 */
export function BrainGraphView({ items, onOpen }: { items: BrainItem[]; onOpen: (id: string) => void }) {
  const motion = useMotion()
  const [showTags, setShowTags] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const onOpenRef = useRef(onOpen)
  useEffect(() => {
    onOpenRef.current = onOpen
  }, [onOpen])
  /** Positions gardées entre deux reconstructions (nouvelle note, tags affichés…) pour ne pas tout rebrasser. */
  const positions = useRef(new Map<string, { x: number; y: number }>())
  const recenterRef = useRef<() => void>(() => {})

  /** Nombre de liens entre notes (sans les tags), pour la légende. */
  const links = useMemo(() => buildBrainGraph(items, { tags: false }).edges.length, [items])

  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Le graphe vit dans l'effet : la simulation le modifie à chaque image, React n'a pas à le voir.
    const graph: BrainGraph = buildBrainGraph(items, { tags: showTags })
    let known = 0
    for (const n of graph.nodes) {
      const p = positions.current.get(n.id)
      if (p) {
        n.x = p.x
        n.y = p.y
        known++
      }
    }
    // Tout était déjà placé : on ne fait que réajuster (alpha bas), sinon on repart de zéro.
    const startAlpha = known === graph.nodes.length ? 0.3 : 1
    if (!motion) settle(graph, startAlpha)

    let palette = readPalette()
    let width = 0
    let height = 0
    const view = { x: 0, y: 0, k: 1 }
    let alpha = motion ? startAlpha : 0
    let frame = 0
    let hover = -1
    let drag: { node: number; moved: boolean; sx: number; sy: number } | null = null
    let pan: { sx: number; sy: number; x: number; y: number } | null = null
    /** Tant que l'utilisateur n'a ni déplacé ni zoomé, on cadre le graphe tout seul. */
    let touched = false

    const toWorld = (sx: number, sy: number) => ({ x: (sx - width / 2 - view.x) / view.k, y: (sy - height / 2 - view.y) / view.k })
    const local = (e: PointerEvent | WheelEvent) => {
      const r = canvas.getBoundingClientRect()
      return { sx: e.clientX - r.left, sy: e.clientY - r.top }
    }

    function draw() {
      const dpr = window.devicePixelRatio || 1
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx!.clearRect(0, 0, width, height)
      ctx!.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (width / 2 + view.x), dpr * (height / 2 + view.y))

      const { nodes, edges, neighbors } = graph
      const focus = hover >= 0 ? neighbors[hover] : null
      const lit = (i: number) => !focus || i === hover || focus.has(i)

      ctx!.lineWidth = 1 / view.k
      ctx!.strokeStyle = palette.edge
      for (const e of edges) {
        const on = focus && (e.source === hover || e.target === hover)
        ctx!.globalAlpha = on ? 0.8 : focus ? 0.06 : e.kind === 'tag' ? 0.18 : 0.35
        ctx!.setLineDash(e.kind === 'tag' ? [3 / view.k, 3 / view.k] : [])
        ctx!.beginPath()
        ctx!.moveTo(nodes[e.source].x, nodes[e.source].y)
        ctx!.lineTo(nodes[e.target].x, nodes[e.target].y)
        ctx!.stroke()
      }
      ctx!.setLineDash([])

      nodes.forEach((n, i) => {
        const r = nodeRadius(n)
        ctx!.globalAlpha = lit(i) ? 1 : 0.15
        ctx!.beginPath()
        ctx!.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx!.fillStyle = palette[n.kind]
        ctx!.fill()
        ctx!.lineWidth = 1.5 / view.k
        ctx!.strokeStyle = palette.ring
        ctx!.stroke()
        if (i === hover) {
          ctx!.beginPath()
          ctx!.arc(n.x, n.y, r + 3 / view.k, 0, Math.PI * 2)
          ctx!.strokeStyle = palette[n.kind]
          ctx!.stroke()
        }
      })

      // Titres : ceux du survol et de ses voisins, les nœuds très reliés, ou tous si on zoome assez.
      const size = 11 / Math.max(view.k, 0.6)
      ctx!.font = `${size}px ${palette.font}`
      ctx!.textAlign = 'center'
      ctx!.textBaseline = 'top'
      ctx!.fillStyle = palette.label
      nodes.forEach((n, i) => {
        const show = focus ? lit(i) : view.k >= LABEL_ZOOM || n.degree >= 4
        if (!show) return
        ctx!.globalAlpha = i === hover ? 1 : 0.75
        const text = n.label.length > 40 ? `${n.label.slice(0, 39)}…` : n.label
        ctx!.fillText(text, n.x, n.y + nodeRadius(n) + 3 / view.k)
      })
      ctx!.globalAlpha = 1
    }

    function loop() {
      frame = 0
      if (motion && alpha > ALPHA_MIN) alpha = tick(graph, alpha)
      draw()
      if (motion && (alpha > ALPHA_MIN || drag)) frame = requestAnimationFrame(loop)
      else {
        savePositions()
        if (!touched) recenterRef.current()
      }
    }
    const start = () => {
      if (!frame) frame = requestAnimationFrame(loop)
    }
    const reheat = (to: number) => {
      alpha = Math.max(alpha, to)
      if (motion) start()
      else draw()
    }
    function savePositions() {
      for (const n of graph.nodes) positions.current.set(n.id, { x: n.x, y: n.y })
    }

    recenterRef.current = () => {
      const { nodes } = graph
      if (!nodes.length) return
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of nodes) {
        minX = Math.min(minX, n.x)
        minY = Math.min(minY, n.y)
        maxX = Math.max(maxX, n.x)
        maxY = Math.max(maxY, n.y)
      }
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((width - 60) / (maxX - minX || 1), (height - 60) / (maxY - minY || 1))))
      view.k = Math.min(k, 1.3)
      view.x = -((minX + maxX) / 2) * view.k
      view.y = -((minY + maxY) / 2) * view.k
      draw()
    }

    const resize = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      width = container.clientWidth
      height = container.clientHeight
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      if (!touched) recenterRef.current()
      draw()
    })
    resize.observe(container)

    // Thème clair / sombre : les couleurs viennent des variables CSS, on les relit au changement.
    const themeWatch = new MutationObserver(() => {
      palette = readPalette()
      draw()
    })
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    function onDown(e: PointerEvent) {
      const { sx, sy } = local(e)
      const p = toWorld(sx, sy)
      const hit = nodeAt(graph, p.x, p.y, 4 / view.k)
      touched = true
      canvas!.setPointerCapture(e.pointerId)
      if (hit >= 0) {
        drag = { node: hit, moved: false, sx, sy }
        graph.nodes[hit].fixed = true
      } else {
        pan = { sx, sy, x: view.x, y: view.y }
        canvas!.style.cursor = 'grabbing'
      }
    }
    function onMove(e: PointerEvent) {
      const { sx, sy } = local(e)
      if (drag) {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 4) return
        drag.moved = true
        const p = toWorld(sx, sy)
        const n = graph.nodes[drag.node]
        n.x = p.x
        n.y = p.y
        reheat(0.25)
        return
      }
      if (pan) {
        view.x = pan.x + sx - pan.sx
        view.y = pan.y + sy - pan.sy
        draw()
        return
      }
      const p = toWorld(sx, sy)
      const hit = nodeAt(graph, p.x, p.y, 4 / view.k)
      if (hit !== hover) {
        hover = hit
        canvas!.style.cursor = hit >= 0 ? (graph.nodes[hit].kind === 'tag' ? 'grab' : 'pointer') : 'grab'
        draw()
      }
    }
    function onUp(e: PointerEvent) {
      canvas!.releasePointerCapture(e.pointerId)
      if (drag) {
        const n = graph.nodes[drag.node]
        n.fixed = false
        if (!drag.moved && n.kind !== 'tag') onOpenRef.current(n.id)
        drag = null
        if (!motion) savePositions()
      }
      if (pan) {
        pan = null
        canvas!.style.cursor = 'grab'
      }
    }
    function onLeave() {
      if (drag || pan || hover < 0) return
      hover = -1
      draw()
    }
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      touched = true
      const { sx, sy } = local(e)
      const before = toWorld(sx, sy)
      view.k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * Math.exp(-e.deltaY * 0.0015)))
      view.x = sx - width / 2 - before.x * view.k
      view.y = sy - height / 2 - before.y * view.k
      draw()
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    if (motion) start()
    else draw()

    return () => {
      cancelAnimationFrame(frame)
      savePositions()
      resize.disconnect()
      themeWatch.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
    }
  }, [items, showTags, motion])

  if (items.length === 0) {
    return <p className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">Ton cerveau est vide pour l’instant.</p>
  }

  return (
    <div className="flex flex-col gap-3">
      <div ref={containerRef} className="relative h-[min(32rem,60dvh)] overflow-hidden rounded-2xl border bg-muted/20">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`Graphe du cerveau : ${items.length} éléments et ${links} liens entre eux.`}
          className="absolute inset-0 cursor-grab touch-none"
        />
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute top-2 right-2 bg-background/80 backdrop-blur"
          onClick={() => recenterRef.current()}
          aria-label="Recentrer le graphe"
          title="Recentrer le graphe"
        >
          <LocateFixed aria-hidden />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        {KINDS.filter((k) => items.some((i) => i.kind === k)).map((k) => {
          const Icon = BRAIN_KIND_ICONS[k]
          return (
            <span key={k} className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full" style={{ background: `var(${KIND_COLORS[k]})` }} aria-hidden />
              <Icon className="size-3.5" aria-hidden />
              {BRAIN_KIND_LABELS[k]}
            </span>
          )
        })}
        <button
          type="button"
          aria-pressed={showTags}
          onClick={() => setShowTags((v) => !v)}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-full border px-2.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            showTags ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted',
          )}
        >
          <Hash className="size-3.5" aria-hidden />
          Tags
        </button>
        <span className="ml-auto tabular-nums">
          {links} lien{links > 1 ? 's' : ''} · clic = ouvrir, molette = zoom
        </span>
      </div>
    </div>
  )
}
