import type { Vec2 } from "../../types/floorplan.ts"
import { dist, norm, sub } from "../geometry.ts"
import { inkNear } from "../ink.ts"

export type ParallelRun = {
  offset: number
  t0: number
  t1: number
}

/** 沿開口方向掃描，收集與牆近乎平行的墨線。offset 是相對中心線的法向位移（像素）。 */
export function parallelRuns(
  ink: Uint8Array,
  width: number,
  height: number,
  a: Vec2,
  b: Vec2,
  halfBand: number,
): ParallelRun[] {
  const length = dist(a, b)
  if (length < 8) return []
  const dir = norm(sub(b, a))
  const normal = { x: -dir.y, y: dir.x }
  const raw: ParallelRun[] = []

  for (let off = -halfBand; off <= halfBand; off += 1) {
    let runStart: number | null = null
    const begin = -48
    const end = length + 48
    for (let t = begin; t <= end; t += 1) {
      const x = a.x + dir.x * t + normal.x * off
      const y = a.y + dir.y * t + normal.y * off
      const on = inkNear(ink, width, height, x, y, 0.6)
      if (on && runStart === null) runStart = t
      if (!on && runStart !== null) {
        const t1 = t - 1
        if (t1 - runStart >= length * 0.34) raw.push({ offset: off, t0: runStart, t1 })
        runStart = null
      }
    }
    if (runStart !== null && end - runStart >= length * 0.34) {
      raw.push({ offset: off, t0: runStart, t1: end })
    }
  }

  raw.sort((p, q) => p.offset - q.offset || p.t0 - q.t0)
  const merged: ParallelRun[] = []
  for (const run of raw) {
    const last = merged[merged.length - 1]
    const overlap =
      last &&
      Math.min(last.t1, run.t1) - Math.max(last.t0, run.t0) >
        0.55 * Math.min(last.t1 - last.t0, run.t1 - run.t0)
    if (last && Math.abs(last.offset - run.offset) <= 1.5 && overlap) {
      last.t0 = Math.min(last.t0, run.t0)
      last.t1 = Math.max(last.t1, run.t1)
      last.offset = (last.offset + run.offset) / 2
    } else {
      merged.push({ ...run })
    }
  }
  return merged
}

export function overlapRatio(a: ParallelRun, b: ParallelRun): number {
  const overlap = Math.min(a.t1, b.t1) - Math.max(a.t0, b.t0)
  const shorter = Math.min(a.t1 - a.t0, b.t1 - b.t0)
  if (shorter <= 0) return 0
  return overlap / shorter
}
