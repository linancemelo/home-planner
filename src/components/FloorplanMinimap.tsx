import { useEffect, useRef } from "react"
import { meterToPixel } from "../lib/geometry.ts"
import { worldToPlan, yawToPlanDir } from "../lib/scene/room.ts"
import type { Floorplan, Vec2 } from "../types/floorplan.ts"

export type PlayerPose = {
  x: number
  z: number
  yaw: number
}

type Props = {
  plan: Floorplan
  player: PlayerPose | null
  className?: string
}

/** 右側小地圖：與 2D 疊圖同一套 Floorplan 公尺／像素轉換，並追蹤漫遊位置與朝向。 */
export function FloorplanMinimap({ plan, player, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const draw = () => {
      const parent = canvas.parentElement
      const cssW = parent?.clientWidth || 260
      const cssH = parent?.clientHeight || 200
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.max(1, Math.floor(cssW * dpr))
      canvas.height = Math.max(1, Math.floor(cssH * dpr))
      canvas.style.width = `${cssW}px`
      canvas.style.height = `${cssH}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)
      ctx.fillStyle = "#f4efe6"
      ctx.fillRect(0, 0, cssW, cssH)

      const origin = plan.meta.coordinateOrigin
      const mpp = plan.meta.metersPerPixel
      const imgH = plan.meta.imageHeightPx
      const toPx = (p: Vec2): Vec2 => {
        if (origin === "top-left") return { x: p.x / mpp, y: p.y / mpp }
        return meterToPixel(p, imgH, mpp)
      }

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      const include = (p: Vec2) => {
        const q = toPx(p)
        minX = Math.min(minX, q.x)
        minY = Math.min(minY, q.y)
        maxX = Math.max(maxX, q.x)
        maxY = Math.max(maxY, q.y)
      }
      for (const wall of plan.walls) {
        include(wall.a)
        include(wall.b)
      }
      for (const door of plan.doors) {
        include(door.opening.a)
        include(door.opening.b)
      }
      for (const win of plan.windows) {
        include(win.opening.a)
        include(win.opening.b)
      }
      if (!Number.isFinite(minX)) {
        minX = 0
        minY = 0
        maxX = 100
        maxY = 100
      }
      const pad = 18
      const bw = Math.max(20, maxX - minX)
      const bh = Math.max(20, maxY - minY)
      const scale = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh)
      const ox = (cssW - bw * scale) / 2 - minX * scale
      const oy = (cssH - bh * scale) / 2 - minY * scale
      const map = (p: Vec2) => {
        const q = toPx(p)
        return { x: q.x * scale + ox, y: q.y * scale + oy }
      }

      ctx.lineCap = "round"
      ctx.lineJoin = "round"
      ctx.strokeStyle = "#1c1917"
      for (const wall of plan.walls) {
        ctx.lineWidth = Math.max(1.6, (wall.thicknessM / mpp) * scale * 0.45)
        const a = map(wall.a)
        const b = map(wall.b)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      ctx.lineWidth = 2
      ctx.strokeStyle = "#d92d20"
      for (const door of plan.doors) {
        const a = map(door.opening.a)
        const b = map(door.opening.b)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      ctx.strokeStyle = "#1570ef"
      for (const win of plan.windows) {
        const a = map(win.opening.a)
        const b = map(win.opening.b)
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      if (player) {
        const planPos = worldToPlan(player.x, player.z, origin)
        const pos = map(planPos)
        const dir = yawToPlanDir(player.yaw, origin)
        // 平面方向 → 疊圖像素方向（左下原點時 Y 向上要再翻成畫布向下）
        const pixDir =
          origin === "top-left"
            ? { x: dir.x, y: dir.y }
            : { x: dir.x, y: -dir.y }
        const ang = Math.atan2(pixDir.y, pixDir.x)
        const coneLen = 28
        const coneHalf = 0.55
        ctx.beginPath()
        ctx.moveTo(pos.x, pos.y)
        ctx.arc(pos.x, pos.y, coneLen, ang - coneHalf, ang + coneHalf)
        ctx.closePath()
        ctx.fillStyle = "rgba(37, 99, 235, 0.28)"
        ctx.fill()
        ctx.beginPath()
        ctx.arc(pos.x, pos.y, 5, 0, Math.PI * 2)
        ctx.fillStyle = "#2563eb"
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = "#eff6ff"
        ctx.stroke()
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    if (canvas.parentElement) ro.observe(canvas.parentElement)
    return () => ro.disconnect()
  }, [plan, player])

  return <canvas ref={canvasRef} className={className ?? "h-full w-full"} />
}
