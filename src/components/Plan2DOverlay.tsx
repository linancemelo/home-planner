import { useEffect, useRef, useState } from "react"
import type { Floorplan, Vec2 } from "../types/floorplan.ts"
import type { PipelineResult } from "../lib/detect/pipeline.ts"
import { add, dist, meterToPixel, mul, sub } from "../lib/geometry.ts"

type Layers = {
  walls: boolean
  doors: boolean
  windows: boolean
  excavations: boolean
}

type Props = {
  imageUrl: string | null
  result: PipelineResult | null
  showBinary: boolean
}

const EMPTY_LAYERS: Layers = { walls: true, doors: true, windows: true, excavations: true }

export function Plan2DOverlay({ imageUrl, result, showBinary }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [layers, setLayers] = useState<Layers>(EMPTY_LAYERS)
  const viewRef = useRef({ scale: 1, x: 0, y: 0 })
  const [viewTick, setViewTick] = useState(0)
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)

  useEffect(() => {
    viewRef.current = { scale: 1, x: 0, y: 0 }
    setViewTick((n) => n + 1)
  }, [imageUrl])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      const view = viewRef.current
      const next = view.scale * (event.deltaY < 0 ? 1.08 : 0.92)
      const scale = Math.min(8, Math.max(0.2, next))
      const k = scale / view.scale
      viewRef.current = {
        scale,
        x: px - (px - view.x) * k,
        y: py - (py - view.y) * k,
      }
      setViewTick((n) => n + 1)
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    if (!canvas || !wrap) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    let cancelled = false
    const image = imageUrl ? loadHtmlImage(imageUrl) : Promise.resolve(null)
    const binary = showBinary && result ? binaryCanvas(result.binary) : null

    void image.then((img) => {
      if (cancelled) return
      const rect = wrap.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, rect.width, rect.height)
      ctx.fillStyle = "#d9d1c4"
      ctx.fillRect(0, 0, rect.width, rect.height)

      const srcW = result?.floorplan.meta.imageWidthPx ?? img?.naturalWidth ?? 0
      const srcH = result?.floorplan.meta.imageHeightPx ?? img?.naturalHeight ?? 0
      if (!srcW || !srcH) {
        drawEmpty(ctx, rect.width, rect.height)
        return
      }

      const view = viewRef.current
      if (view.scale === 1 && view.x === 0 && view.y === 0) {
        const fit = Math.min(rect.width / srcW, rect.height / srcH) * 0.94
        view.scale = fit
        view.x = (rect.width - srcW * fit) / 2
        view.y = (rect.height - srcH * fit) / 2
      }

      ctx.save()
      ctx.translate(view.x, view.y)
      ctx.scale(view.scale, view.scale)
      if (showBinary && binary) {
        ctx.drawImage(binary, 0, 0, srcW, srcH)
      } else if (img) {
        ctx.drawImage(img, 0, 0, srcW, srcH)
      } else {
        ctx.fillStyle = "#f4efe6"
        ctx.fillRect(0, 0, srcW, srcH)
      }
      if (result) drawPlan(ctx, result.floorplan, result.excavations, layers)
      ctx.restore()
    }).catch(() => {
      if (cancelled) return
    })

    return () => {
      cancelled = true
    }
  }, [imageUrl, result, showBinary, layers, viewTick])

  const reset = () => {
    viewRef.current = { scale: 1, x: 0, y: 0 }
    setViewTick((n) => n + 1)
  }

  return (
    <div className="flex h-full min-h-[420px] flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <LayerButton on={layers.walls} color="#111111" label="牆" onClick={() => setLayers((s) => ({ ...s, walls: !s.walls }))} />
        <LayerButton on={layers.doors} color="#d92d20" label="門" onClick={() => setLayers((s) => ({ ...s, doors: !s.doors }))} />
        <LayerButton on={layers.windows} color="#1570ef" label="窗" onClick={() => setLayers((s) => ({ ...s, windows: !s.windows }))} />
        <LayerButton
          on={layers.excavations}
          color="#8a8f98"
          label="挖除"
          dashed
          onClick={() => setLayers((s) => ({ ...s, excavations: !s.excavations }))}
        />
        <button type="button" onClick={reset} className="ml-auto rounded-md px-2 py-1 text-xs text-[#1f3a5f] hover:bg-[#efe8dc]">
          重設視圖
        </button>
      </div>
      <div
        ref={wrapRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-[#ddd4c6] bg-[#d9d1c4]"
      >
        <canvas
          ref={canvasRef}
          className="h-full w-full touch-none"
          onPointerDown={(event) => {
            const view = viewRef.current
            drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y }
            event.currentTarget.setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            if (!drag.current) return
            viewRef.current = {
              ...viewRef.current,
              x: drag.current.vx + event.clientX - drag.current.x,
              y: drag.current.vy + event.clientY - drag.current.y,
            }
            setViewTick((n) => n + 1)
          }}
          onPointerUp={() => {
            drag.current = null
          }}
        />
      </div>
      <p className="mt-2 text-xs text-[#6b645c]">滾輪縮放，拖曳平移。挖除段是日後 3D 不該再擠出的牆。</p>
    </div>
  )
}

function LayerButton({
  on,
  color,
  label,
  dashed,
  onClick,
}: {
  on: boolean
  color: string
  label: string
  dashed?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
        on ? "border-[#1f3a5f] bg-white" : "border-transparent bg-[#efe8dc] text-[#8a8175]"
      }`}
    >
      <span
        className="inline-block w-4 border-t-2"
        style={{ borderColor: color, borderStyle: dashed ? "dashed" : "solid", opacity: on ? 1 : 0.4 }}
      />
      {label}
    </button>
  )
}

function drawEmpty(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.fillStyle = "#6b645c"
  ctx.font = "14px 'Noto Sans TC', sans-serif"
  ctx.textAlign = "center"
  ctx.fillText("上傳平面圖後，牆、門、窗會疊在原圖上", w / 2, h / 2)
}

function drawPlan(
  ctx: CanvasRenderingContext2D,
  plan: Floorplan,
  excavations: PipelineResult["excavations"],
  layers: Layers,
) {
  const { metersPerPixel: mpp, imageHeightPx } = plan.meta
  const toPx = (p: Vec2) => meterToPixel(p, imageHeightPx, mpp)

  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  if (layers.excavations) {
    ctx.save()
    ctx.strokeStyle = "rgba(90, 96, 104, 0.72)"
    ctx.lineWidth = 5
    ctx.setLineDash([7, 6])
    for (const gap of excavations) {
      const a = toPx(gap.a)
      const b = toPx(gap.b)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    ctx.restore()
  }

  if (layers.walls) {
    ctx.strokeStyle = "#111111"
    ctx.setLineDash([])
    for (const wall of plan.walls) {
      ctx.lineWidth = Math.max(2.2, wall.thicknessM / mpp)
      const a = toPx(wall.a)
      const b = toPx(wall.b)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
  }

  if (layers.windows) {
    ctx.strokeStyle = "#1570ef"
    ctx.lineWidth = 2.4
    ctx.setLineDash([])
    for (const win of plan.windows) {
      const a = toPx(win.opening.a)
      const b = toPx(win.opening.b)
      strokeSegment(ctx, a, b)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      const nx = -dy / len
      const ny = dx / len
      ctx.lineWidth = 1.3
      for (const off of [-3.2, 3.2]) {
        ctx.beginPath()
        ctx.moveTo(a.x + nx * off, a.y + ny * off)
        ctx.lineTo(b.x + nx * off, b.y + ny * off)
        ctx.stroke()
      }
    }
  }

  if (layers.doors) {
    ctx.strokeStyle = "#d92d20"
    ctx.setLineDash([])
    const byId = new Map(plan.walls.map((w) => [w.id, w]))
    for (const door of plan.doors) {
      const a = toPx(door.opening.a)
      const b = toPx(door.opening.b)
      ctx.lineWidth = 2.6
      strokeSegment(ctx, a, b)
      if (door.kind === "swing" && door.swing) {
        const wall = byId.get(door.wallId)
        if (!wall) continue
        const hinge = toPx(door.swing.hinge)
        const otherM =
          dist(door.opening.a, door.swing.hinge) <= dist(door.opening.b, door.swing.hinge)
            ? door.opening.b
            : door.opening.a
        const other = toPx(otherM)
        const wallDir = sub(wall.b, wall.a)
        const wlen = Math.hypot(wallDir.x, wallDir.y) || 1
        const ux = wallDir.x / wlen
        const uy = wallDir.y / wlen
        const leaf =
          door.swing.openDirection === "ccw"
            ? { x: -uy, y: ux }
            : { x: uy, y: -ux }
        const tipM = add(door.swing.hinge, mul(leaf, door.swing.leafLengthM))
        const tip = toPx(tipM)
        ctx.lineWidth = 1.6
        strokeSegment(ctx, hinge, tip)
        const a0 = Math.atan2(other.y - hinge.y, other.x - hinge.x)
        const a1 = Math.atan2(tip.y - hinge.y, tip.x - hinge.x)
        let sweep = a1 - a0
        while (sweep > Math.PI) sweep -= Math.PI * 2
        while (sweep < -Math.PI) sweep += Math.PI * 2
        const radius = door.swing.leafLengthM / mpp
        ctx.beginPath()
        const steps = 18
        for (let i = 0; i <= steps; i++) {
          const ang = a0 + (sweep * i) / steps
          const x = hinge.x + Math.cos(ang) * radius
          const y = hinge.y + Math.sin(ang) * radius
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
      }
      if (door.kind === "sliding" && door.sliding) {
        ctx.lineWidth = 1.6
        strokeSegment(ctx, toPx(door.sliding.leafA.a), toPx(door.sliding.leafA.b))
        strokeSegment(ctx, toPx(door.sliding.leafB.a), toPx(door.sliding.leafB.b))
      }
    }
  }
}

function strokeSegment(ctx: CanvasRenderingContext2D, a: Vec2, b: Vec2) {
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("圖片載入失敗"))
    img.src = src
  })
}

function binaryCanvas(binary: PipelineResult["binary"]): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = binary.width
  canvas.height = binary.height
  const ctx = canvas.getContext("2d")
  if (!ctx) return canvas
  const image = ctx.createImageData(binary.width, binary.height)
  for (let i = 0; i < binary.ink.length; i++) {
    const on = binary.ink[i] === 1
    const o = i * 4
    image.data[o] = on ? 28 : 246
    image.data[o + 1] = on ? 28 : 242
    image.data[o + 2] = on ? 28 : 232
    image.data[o + 3] = 255
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}
