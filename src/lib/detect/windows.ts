import type { Vec2 } from "../../types/floorplan.ts"
import { dist, norm, sub } from "../geometry.ts"
import { inkNear } from "../ink.ts"
import { overlapRatio, parallelRuns, parallelSegments, type ParallelRun } from "./runs.ts"
import type { PixelGap, WallFragment } from "./walls.ts"

export type WindowEval =
  | { status: "none" }
  | { status: "insufficient" }
  | { status: "extends-outside" }
  | { status: "closed-rect" }
  | { status: "cavity" }
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
  if (openingM >= 1.8 && Math.abs(pair[0].offset - pair[1].offset) >= 2) {
    return { status: "cavity" }
  }
  return { status: "window", confidence }
}

export type PlacedWindow = { openingA: Vec2; openingB: Vec2; confidence: number }

/** 牆帶裡、短於整道牆的兩或三條對齊細線。三條平行線優先，避免把家具矩形當窗。 */
export function findWindowsOnWalls(
  ink: Uint8Array,
  gray: Uint8Array,
  cleaned: Uint8Array,
  width: number,
  height: number,
  fragments: WallFragment[],
  mpp: number,
  notes: string[] = [],
): PlacedWindow[] {
  const minLen = Math.max(22, 0.42 / mpp)
  const maxLen = Math.min(280, 2.9 / mpp)
  const found: PlacedWindow[] = []
  for (const frag of fragments) {
    const dx = Math.abs(frag.b.x - frag.a.x)
    const dy = Math.abs(frag.b.y - frag.a.y)
    if (!(dx < 4 || dy < 4 || (dx > 0 && dy / dx < 0.12) || (dy > 0 && dx / dy < 0.12))) continue
    const len = dist(frag.a, frag.b)
    if (len < minLen) continue
    const dir = norm(sub(frag.b, frag.a))
    const band = Math.max(frag.thicknessPx * 0.85, 9)
    const runs = parallelSegments(ink, width, height, frag.a, frag.b, band, minLen * 0.55)
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]
        const b = runs[j]
        const sep = Math.abs(a.offset - b.offset)
        if (sep < 2 || sep > 9) continue
        if (overlapRatio(a, b) < 0.8) continue
        const faceSep = sep > Math.min(6.5, Math.max(4, frag.thicknessPx * 0.48))
        const span0 = Math.max(a.t0, b.t0)
        const span1 = Math.min(a.t1, b.t1)
        const span = span1 - span0
        if (span < minLen || span > maxLen) continue
        if (span > len * 0.86) continue
        const midOff = (a.offset + b.offset) / 2
        if (Math.abs(midOff) > Math.max(frag.thicknessPx * 0.62, 7)) continue
        let lines = 2
        const lo = Math.min(a.offset, b.offset)
        const hi = Math.max(a.offset, b.offset)
        for (let k = 0; k < runs.length; k++) {
          if (k === i || k === j) continue
          const c = runs[k]
          if (c.offset <= lo + 1.5 || c.offset >= hi - 1.5) continue
          if (overlapRatio(c, a) < 0.75 || overlapRatio(c, b) < 0.75) continue
          lines = 3
          break
        }
        if (lines < 3 && faceSep) continue
        const gap: PixelGap = {
          a: { x: frag.a.x + dir.x * span0, y: frag.a.y + dir.y * span0 },
          b: { x: frag.a.x + dir.x * span1, y: frag.a.y + dir.y * span1 },
          thicknessPx: frag.thicknessPx,
        }
        if (lines < 3 && closedRectangle(ink, width, height, gap, a, b, span, mpp)) continue
        const inWall = windowSitsInWall(gray, cleaned, width, height, frag, span0, span1)
        const exterior = facesExterior(gray, width, height, frag, span0, span1)
        const short = span <= Math.max(52, 0.95 / mpp) && span < len * 0.4
        if (!inWall && !(exterior && lines >= 3 && short)) continue
        const meters = span * mpp
        if (meters >= 1.8 && lines >= 2 && (cavityLike(gray, cleaned, width, height, frag, span0, span1, sep) || lines >= 3)) {
          notes.push("待查：可能空心牆腔")
          continue
        }
        found.push({
          openingA: gap.a,
          openingB: gap.b,
          confidence: lines >= 3 ? 0.8 : 0.66,
        })
      }
    }
  }
  const ranked = [...found].sort((a, b) => b.confidence - a.confidence || dist(b.openingA, b.openingB) - dist(a.openingA, a.openingB))
  const kept: PlacedWindow[] = []
  for (const hit of ranked) {
    const mid = { x: (hit.openingA.x + hit.openingB.x) / 2, y: (hit.openingA.y + hit.openingB.y) / 2 }
    const len = dist(hit.openingA, hit.openingB)
    const clash = kept.some((other) => {
      const mid2 = { x: (other.openingA.x + other.openingB.x) / 2, y: (other.openingA.y + other.openingB.y) / 2 }
      return dist(mid, mid2) < Math.max(12, len * 0.45)
    })
    if (!clash) kept.push(hit)
  }
  return kept
}

/** 牆的一側是空白（戶外或陽台），另一側不是。外牆上的短平行線比室內家具更像窗。 */
function facesExterior(
  gray: Uint8Array,
  width: number,
  height: number,
  frag: WallFragment,
  span0: number,
  span1: number,
): boolean {
  const dx = frag.b.x - frag.a.x
  const dy = frag.b.y - frag.a.y
  const len = Math.hypot(dx, dy) || 1
  const dirX = dx / len
  const dirY = dy / len
  const nx = -dirY
  const ny = dirX
  const distOff = Math.max(frag.thicknessPx, 8) + 14
  const t = (span0 + span1) / 2
  const sample = (sign: number) => {
    let sum = 0
    let n = 0
    for (let dt = -12; dt <= 12; dt += 6) {
      const x = Math.round(frag.a.x + dirX * (t + dt) + nx * distOff * sign)
      const y = Math.round(frag.a.y + dirY * (t + dt) + ny * distOff * sign)
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      sum += gray[y * width + x]
      n++
    }
    return n === 0 ? 128 : sum / n
  }
  const plus = sample(1)
  const minus = sample(-1)
  return Math.abs(plus - minus) > 45 && Math.max(plus, minus) > 175
}

/** 很長、外線距接近牆厚、內部是空的，比較像雙線牆的空腔而不是窗。 */
function cavityLike(
  gray: Uint8Array,
  cleaned: Uint8Array,
  width: number,
  height: number,
  frag: WallFragment,
  span0: number,
  span1: number,
  outerSep: number,
): boolean {
  const thick = Math.max(frag.thicknessPx, 6)
  if (outerSep < thick * 0.45 || outerSep > thick * 1.2) return false
  const dx = frag.b.x - frag.a.x
  const dy = frag.b.y - frag.a.y
  const len = Math.hypot(dx, dy) || 1
  const dirX = dx / len
  const dirY = dy / len
  const nx = -dirY
  const ny = dirX
  let hollow = 0
  for (let s = 1; s <= 5; s++) {
    const t = span0 + ((span1 - span0) * s) / 6
    const cx = frag.a.x + dirX * t
    const cy = frag.a.y + dirY * t
    let interiorInk = 0
    let interiorN = 0
    let faceInk = 0
    let faceN = 0
    const half = Math.max(outerSep / 2, thick / 2)
    for (let off = -half; off <= half; off += 1) {
      const x = Math.round(cx + nx * off)
      const y = Math.round(cy + ny * off)
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue
      const g = gray[y * width + x]
      const on = cleaned[y * width + x] === 1
      if (Math.abs(off) >= half - 1.6) {
        faceN++
        if (on || g < 80) faceInk++
      } else {
        interiorN++
        if (on || g < 60) interiorInk++
      }
    }
    if (faceN > 0 && interiorN > 0 && faceInk / faceN >= 0.35 && interiorInk / interiorN <= 0.45) hollow++
  }
  return hollow >= 3
}

/** 細線要在實心牆的淺色凹槽裡，或在雙線牆的空腔裡。貼在牆外的家具平行線不算窗。 */
function windowSitsInWall(
  gray: Uint8Array,
  cleaned: Uint8Array,
  width: number,
  height: number,
  frag: WallFragment,
  span0: number,
  span1: number,
): boolean {
  const dx = frag.b.x - frag.a.x
  const dy = frag.b.y - frag.a.y
  const len = Math.hypot(dx, dy) || 1
  const dirX = dx / len
  const dirY = dy / len
  const nx = -dirY
  const ny = dirX
  const thick = Math.max(frag.thicknessPx, 6)
  let grooves = 0
  let hollow = 0
  const stations = 5
  for (let s = 1; s <= stations; s++) {
    const t = span0 + ((span1 - span0) * s) / (stations + 1)
    const cx = frag.a.x + dirX * t
    const cy = frag.a.y + dirY * t
    let light = false
    let interiorInk = 0
    let interiorN = 0
    let faceInk = 0
    let faceN = 0
    const half = thick / 2
    for (let off = -half; off <= half; off += 1) {
      const x = Math.round(cx + nx * off)
      const y = Math.round(cy + ny * off)
      if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) continue
      const g = gray[y * width + x]
      const on = cleaned[y * width + x] === 1
      if (Math.abs(off) >= half - 1.6) {
        faceN++
        if (on || g < 72) faceInk++
      } else {
        interiorN++
        if (on) interiorInk++
        const g0 = gray[Math.round(cy + ny * (off - 2)) * width + Math.round(cx + nx * (off - 2))] ?? 255
        const g1 = gray[Math.round(cy + ny * (off + 2)) * width + Math.round(cx + nx * (off + 2))] ?? 255
        if (g >= 88 && g0 < 90 && g1 < 90 && g > g0 + 20 && g > g1 + 20) light = true
      }
    }
    if (light) grooves++
    if (faceN > 0 && interiorN > 0 && faceInk / faceN >= 0.4 && interiorInk / interiorN <= 0.5) hollow++
  }
  return grooves >= 1 || hollow >= 2
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
