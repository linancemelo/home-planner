/** Canvas overlay: source image + wall (black) / door (red) / window (blue) / excavation (grey dashed). */
import type { Excavation, Floorplan, Vec2 } from "./floorplan.ts"
import { meterToPixel } from "./geometry.ts"

export type OverlayLayers = {
  walls: boolean
  doors: boolean
  windows: boolean
  excavations: boolean
}

export const DEFAULT_OVERLAY_LAYERS: OverlayLayers = {
  walls: true,
  doors: true,
  windows: true,
  excavations: true,
}

function m2p(p: Vec2, fp: Floorplan): Vec2 {
  return meterToPixel(p, fp.meta.imageHeightPx, fp.meta.metersPerPixel)
}

export function drawFloorplanOverlay(
  ctx: CanvasRenderingContext2D,
  opts: {
    image: HTMLImageElement | null
    floorplan: Floorplan
    excavations?: Excavation[]
    layers?: OverlayLayers
    width: number
    height: number
  },
): void {
  const { image, floorplan: fp, excavations = [], width, height } = opts
  const layers = opts.layers ?? DEFAULT_OVERLAY_LAYERS
  const srcW = fp.meta.imageWidthPx
  const srcH = fp.meta.imageHeightPx
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = "#e8dcc8"
  ctx.fillRect(0, 0, width, height)

  const fit = Math.min(width / srcW, height / srcH) * 0.94
  const ox = (width - srcW * fit) / 2
  const oy = (height - srcH * fit) / 2
  ctx.save()
  ctx.translate(ox, oy)
  ctx.scale(fit, fit)

  if (image) {
    ctx.globalAlpha = 0.92
    ctx.drawImage(image, 0, 0, srcW, srcH)
    ctx.globalAlpha = 1
  } else {
    ctx.fillStyle = "#f4eee4"
    ctx.fillRect(0, 0, srcW, srcH)
  }

  const strokeSeg = (a: Vec2, b: Vec2, color: string, widthPx: number, dash?: number[]) => {
    const pa = m2p(a, fp)
    const pb = m2p(b, fp)
    ctx.beginPath()
    ctx.moveTo(pa.x, pa.y)
    ctx.lineTo(pb.x, pb.y)
    ctx.strokeStyle = color
    ctx.lineWidth = widthPx / fit
    ctx.setLineDash(dash ? dash.map((d) => d / fit) : [])
    ctx.lineCap = "round"
    ctx.stroke()
    ctx.setLineDash([])
  }

  if (layers.excavations) {
    for (const e of excavations) {
      strokeSeg(e.a, e.b, "rgba(90,90,90,0.85)", 3, [8, 6])
    }
  }
  if (layers.walls) {
    for (const w of fp.walls) strokeSeg(w.a, w.b, "#1a1a1a", 4)
  }
  if (layers.doors) {
    for (const d of fp.doors) {
      strokeSeg(d.opening.a, d.opening.b, "#c0392b", 5)
      if (d.kind === "swing" && d.swing) {
        const h = m2p(d.swing.hinge, fp)
        const tipLen = d.swing.leafLengthM / fp.meta.metersPerPixel
        // Approximate open leaf along +X of opening for preview
        const open = m2p(d.opening.b, fp)
        const closed = m2p(d.opening.a, fp)
        const dx = open.x - closed.x
        const dy = open.y - closed.y
        const L = Math.hypot(dx, dy) || 1
        const px = -dy / L
        const py = dx / L
        const sign = d.swing.openDirection === "cw" ? 1 : -1
        ctx.beginPath()
        ctx.moveTo(h.x, h.y)
        ctx.lineTo(h.x + sign * px * tipLen, h.y + sign * py * tipLen)
        ctx.strokeStyle = "#c0392b"
        ctx.lineWidth = 2.5 / fit
        ctx.stroke()
      }
    }
  }
  if (layers.windows) {
    for (const w of fp.windows) strokeSeg(w.opening.a, w.opening.b, "#2980b9", 5)
  }

  ctx.restore()
}
