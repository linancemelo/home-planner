import { dist } from "../geometry.ts"
import { inkNear } from "../ink.ts"
import type { PixelGap } from "./walls.ts"
import { overlapRatio, parallelRuns, type ParallelRun } from "./runs.ts"

export type WindowEval =
  | { status: "none" }
  | { status: "insufficient" }
  | { status: "extends-outside" }
  | { status: "closed-rect" }
  | { status: "window"; confidence: number }

export function evaluateWindow(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  mpp: number,
): WindowEval {
  const openingPx = dist(gap.a, gap.b)
  const openingM = openingPx * mpp
  const pixelSized = openingPx >= 22 && openingPx <= 240
  if ((openingM < 0.4 && !pixelSized) || openingM > 3.2) return { status: "none" }

  const band = Math.max(gap.thicknessPx * 0.85, 8)
  const runs = parallelRuns(ink, width, height, gap.a, gap.b, band).filter((run) => {
    return Math.abs(run.offset) < gap.thicknessPx * 0.72
  })

  if (runs.length === 0) return { status: "none" }

  const aligned: [ParallelRun, ParallelRun][] = []
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const sep = Math.abs(runs[i].offset - runs[j].offset)
      if (sep < 2) continue
      if (overlapRatio(runs[i], runs[j]) < 0.84) continue
      const lenA = runs[i].t1 - runs[i].t0
      const lenB = runs[j].t1 - runs[j].t0
      if (lenA < openingPx * 0.45 || lenB < openingPx * 0.45) continue
      aligned.push([runs[i], runs[j]])
    }
  }

  if (aligned.length === 0) {
    const longEnough = runs.some((run) => run.t1 - run.t0 > openingPx * 0.45)
    return longEnough ? { status: "insufficient" } : { status: "none" }
  }

  const pair = aligned[0]
  const t0 = Math.min(pair[0].t0, pair[1].t0)
  const t1 = Math.max(pair[0].t1, pair[1].t1)
  const extendsBefore = t0 < -Math.max(16, openingPx * 0.18)
  const extendsAfter = t1 > openingPx + Math.max(16, openingPx * 0.18)
  if (extendsBefore || extendsAfter) return { status: "extends-outside" }

  if (closedRectangle(ink, width, height, gap, pair[0], pair[1], openingPx, mpp)) {
    return { status: "closed-rect" }
  }

  const span = Math.min(pair[0].t1, pair[1].t1) - Math.max(pair[0].t0, pair[1].t0)
  const confidence = Math.round(Math.min(0.88, 0.5 + (span / openingPx) * 0.3) * 100) / 100
  return { status: "window", confidence }
}

function closedRectangle(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  a: ParallelRun,
  b: ParallelRun,
  openingPx: number,
  mpp: number,
): boolean {
  const cap0 = capStrength(ink, width, height, gap, a, b, Math.max(a.t0, b.t0))
  const cap1 = capStrength(ink, width, height, gap, a, b, Math.min(a.t1, b.t1))
  const outside = Math.min(a.t0, b.t0) < -12 || Math.max(a.t1, b.t1) > openingPx + 12
  const shortFurniture = openingPx * mpp < 0.7
  return cap0 > 0.72 && cap1 > 0.72 && (outside || shortFurniture)
}

function capStrength(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  a: ParallelRun,
  b: ParallelRun,
  t: number,
): number {
  const dx = gap.b.x - gap.a.x
  const dy = gap.b.y - gap.a.y
  const length = Math.hypot(dx, dy) || 1
  const dirX = dx / length
  const dirY = dy / length
  const nx = -dirY
  const ny = dirX
  const off0 = Math.min(a.offset, b.offset)
  const off1 = Math.max(a.offset, b.offset)
  let hit = 0
  let total = 0
  for (let off = off0; off <= off1; off += 1) {
    const x = gap.a.x + dirX * t + nx * off
    const y = gap.a.y + dirY * t + ny * off
    total++
    if (inkNear(ink, width, height, x, y, 1)) hit++
  }
  return total === 0 ? 0 : hit / total
}
