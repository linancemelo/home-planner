import type { Vec2 } from "../../types/floorplan.ts"
import { circDistDeg, dist, norm, sub } from "../geometry.ts"
import { inkNear } from "../ink.ts"
import type { PixelGap } from "./walls.ts"
import { overlapRatio, parallelRuns } from "./runs.ts"

export type SwingHit = {
  status: "swing"
  hinge: Vec2
  leafTip: Vec2
  leafLengthPx: number
  confidence: number
}

export type SlidingHit = {
  status: "sliding"
  leafA: { a: Vec2; b: Vec2 }
  leafB: { a: Vec2; b: Vec2 }
  confidence: number
}

export type DoorEval = { status: "none" } | { status: "partial" } | SwingHit | SlidingHit

export function evaluateDoor(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  mpp: number,
): DoorEval {
  const openingPx = dist(gap.a, gap.b)
  const openingM = openingPx * mpp
  const swing = evaluateSwing(ink, width, height, gap, openingPx)
  if (swing.status === "swing") return swing

  const sliding = evaluateSliding(ink, width, height, gap, openingPx)
  if (sliding) return sliding

  if (openingM >= 0.5 && openingM <= 1.35 && swing.status === "partial") {
    return { status: "partial" }
  }
  return { status: "none" }
}

function evaluateSwing(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  openingPx: number,
): { status: "none" } | { status: "partial" } | SwingHit {
  const hinges = [gap.a, gap.b]
  let best: SwingHit | null = null
  let partial = false

  for (const hinge of hinges) {
    const other = hinge === gap.a ? gap.b : gap.a
    const wallDeg = toDeg(Math.atan2(other.y - hinge.y, other.x - hinge.x))
    const hits = sampleArc(ink, width, height, hinge, openingPx)
    const arc = bestArcWindow(hits, wallDeg)
    const leaf = bestLeaf(ink, width, height, hinge, openingPx, wallDeg)

    const arcOk = arc !== null && arc.rate >= 0.5
    const leafOk =
      leaf !== null &&
      leaf.density >= 0.42 &&
      leaf.length >= openingPx * 0.9 &&
      leaf.length <= openingPx * 1.1

    if (arcOk && leafOk && arc && leaf) {
      const leafRad = (leaf.deg * Math.PI) / 180
      const confidence = Math.round(Math.min(0.9, 0.45 + arc.rate * 0.3 + leaf.density * 0.2) * 100) / 100
      const hit: SwingHit = {
        status: "swing",
        hinge,
        leafTip: {
          x: hinge.x + Math.cos(leafRad) * leaf.length,
          y: hinge.y + Math.sin(leafRad) * leaf.length,
        },
        leafLengthPx: leaf.length,
        confidence,
      }
      if (!best || hit.confidence > best.confidence) best = hit
      continue
    }

    const arcPartial = arc !== null && arc.rate >= 0.34
    const leafPartial = leaf !== null && leaf.density >= 0.4 && leaf.length >= openingPx * 0.7
    if (arcPartial || leafPartial) partial = true
  }

  if (best) return best
  if (partial) return { status: "partial" }
  return { status: "none" }
}

function evaluateSliding(
  ink: Uint8Array,
  width: number,
  height: number,
  gap: PixelGap,
  openingPx: number,
): SlidingHit | null {
  if (arcStrength(ink, width, height, gap.a, openingPx) > 0.32) return null
  if (arcStrength(ink, width, height, gap.b, openingPx) > 0.32) return null

  const runs = parallelRuns(ink, width, height, gap.a, gap.b, Math.max(16, gap.thicknessPx))
  let best: { score: number; a: (typeof runs)[0]; b: (typeof runs)[0] } | null = null
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      const a = runs[i]
      const b = runs[j]
      const sep = Math.abs(a.offset - b.offset)
      if (sep < 3 || sep > 16) continue
      const lenA = a.t1 - a.t0
      const lenB = b.t1 - b.t0
      if (lenA < openingPx * 0.4 || lenB < openingPx * 0.4) continue
      const overlap = overlapRatio(a, b)
      if (overlap < 0.22 || overlap > 0.82) continue
      const midA = (a.t0 + a.t1) / 2
      const midB = (b.t0 + b.t1) / 2
      if (Math.abs(midA - midB) < openingPx * 0.1) continue
      const score = (1 - Math.abs(overlap - 0.5)) * Math.min(lenA, lenB)
      if (!best || score > best.score) best = { score, a, b }
    }
  }
  if (!best) return null

  const toSeg = (run: (typeof runs)[0]) => {
    const dir = norm(sub(gap.b, gap.a))
    const normal = { x: -dir.y, y: dir.x }
    const at = (t: number) => ({
      x: gap.a.x + dir.x * t + normal.x * run.offset,
      y: gap.a.y + dir.y * t + normal.y * run.offset,
    })
    return { a: at(run.t0), b: at(run.t1) }
  }

  return {
    status: "sliding",
    leafA: toSeg(best.a),
    leafB: toSeg(best.b),
    confidence: 0.72,
  }
}

function sampleArc(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
): boolean[] {
  const hits: boolean[] = []
  for (let deg = 0; deg < 360; deg += 3) {
    const ang = (deg * Math.PI) / 180
    let hit = false
    for (const scale of [0.93, 1, 1.07]) {
      const x = hinge.x + Math.cos(ang) * radius * scale
      const y = hinge.y + Math.sin(ang) * radius * scale
      if (inkNear(ink, w, h, x, y, 1.7)) {
        hit = true
        break
      }
    }
    hits.push(hit)
  }
  return hits
}

function bestArcWindow(
  hits: boolean[],
  wallDeg: number,
): { rate: number; leafDeg: number } | null {
  const bins = hits.length
  let best: { rate: number; leafDeg: number } | null = null
  const minSize = Math.round(68 / 3)
  const maxSize = Math.round(112 / 3)
  for (let size = minSize; size <= maxSize; size++) {
    for (let s = 0; s < bins; s++) {
      let hit = 0
      for (let k = 0; k < size; k++) if (hits[(s + k) % bins]) hit++
      const rate = hit / size
      if (rate < 0.48) continue
      const startDeg = s * 3
      const endDeg = ((s + size - 1) * 3) % 360
      const d0 = circDistDeg(startDeg, wallDeg)
      const d1 = circDistDeg(endDeg, wallDeg)
      if (d0 > 24 && d1 > 24) continue
      const leafDeg = d0 <= d1 ? endDeg : startDeg
      if (!best || rate > best.rate) best = { rate, leafDeg }
    }
  }
  return best
}

function bestLeaf(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
  wallDeg: number,
): { density: number; length: number; deg: number } | null {
  let best: { density: number; length: number; deg: number } | null = null
  for (let deg = 0; deg < 360; deg += 6) {
    if (circDistDeg(deg, wallDeg) < 38) continue
    if (circDistDeg(deg, wallDeg) > 125) continue
    const measured = measureRay(ink, w, h, hinge, deg, radius)
    if (!best || measured.density * measured.length > best.density * best.length) {
      best = { ...measured, deg }
    }
  }
  return best
}

function measureRay(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  deg: number,
  radius: number,
): { density: number; length: number } {
  const ang = (deg * Math.PI) / 180
  let inkCount = 0
  let total = 0
  let last = 0
  let gap = 0
  const maxR = radius * 1.15
  for (let t = 2; t <= maxR; t += 1) {
    const x = hinge.x + Math.cos(ang) * t
    const y = hinge.y + Math.sin(ang) * t
    total++
    if (inkNear(ink, w, h, x, y, 1.5)) {
      inkCount++
      last = t
      gap = 0
    } else {
      gap++
      if (gap > 6 && t > radius * 0.35) break
    }
  }
  return { density: total === 0 ? 0 : inkCount / total, length: last }
}

function arcStrength(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
): number {
  const hits = sampleArc(ink, w, h, hinge, radius)
  let best = 0
  const size = Math.round(90 / 3)
  for (let s = 0; s < hits.length; s++) {
    let hit = 0
    for (let k = 0; k < size; k++) if (hits[(s + k) % hits.length]) hit++
    best = Math.max(best, hit / size)
  }
  return best
}

function toDeg(rad: number): number {
  let deg = (rad * 180) / Math.PI
  if (deg < 0) deg += 360
  return deg
}
