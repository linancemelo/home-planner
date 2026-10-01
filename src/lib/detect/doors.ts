import type { Vec2 } from "../../types/floorplan.ts"
import { circDistDeg, dist, norm, sub } from "../geometry.ts"
import { inkNear } from "../ink.ts"
import { overlapRatio, parallelRuns, parallelSegments } from "./runs.ts"
import type { PixelGap, WallFragment } from "./walls.ts"

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
    const hits = sampleArc(ink, width, height, hinge, openingPx, gap)
    const arc = bestArcWindow(hits, wallDeg)
    if (arc && oppositeRaw(hits, arc.start, arc.size) > 0.28) continue
    const leaf = bestLeaf(ink, width, height, hinge, openingPx, wallDeg)

    const arcOk = arc !== null
    const leafOk =
      leaf !== null &&
      leaf.density >= 0.42 &&
      leaf.length >= openingPx * 0.9 &&
      leaf.length <= openingPx * 1.1
    const aligned = arc !== null && leaf !== null && circDistDeg(leaf.deg, arc.leafDeg) <= 32

    if (arcOk && leafOk && aligned && arc && leaf) {
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

type ArcSample = { hit: boolean; free: boolean }

function sampleArc(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
  gap?: PixelGap,
): ArcSample[] {
  const hits: ArcSample[] = []
  for (let deg = 0; deg < 360; deg += 3) {
    const ang = (deg * Math.PI) / 180
    let hit = false
    let free = true
    for (const scale of [0.93, 1, 1.07]) {
      const x = hinge.x + Math.cos(ang) * radius * scale
      const y = hinge.y + Math.sin(ang) * radius * scale
      if (gap && inWallBand(x, y, gap)) {
        free = false
        break
      }
      if (tangentStroke(ink, w, h, x, y, ang)) {
        hit = true
        break
      }
    }
    hits.push({ hit: free && hit, free })
  }
  return hits
}

/** 貼在牆中心線上的點是牆，不是門弧。 */
function inWallBand(x: number, y: number, gap: PixelGap): boolean {
  const dx = gap.b.x - gap.a.x
  const dy = gap.b.y - gap.a.y
  const len = Math.hypot(dx, dy) || 1
  const off = ((x - gap.a.x) * -dy + (y - gap.a.y) * dx) / len
  return Math.abs(off) <= Math.max(gap.thicknessPx * 0.55, 4)
}

/** 圓弧上的墨必須順著切線走。木紋和實心牆緣只在少數角度擦到，不算。 */
function tangentStroke(
  ink: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  ang: number,
): boolean {
  if (!inkNear(ink, w, h, x, y, 2.1)) return false
  const tx = -Math.sin(ang)
  const ty = Math.cos(ang)
  const ahead = inkNear(ink, w, h, x + tx * 4, y + ty * 4, 1.8)
  const behind = inkNear(ink, w, h, x - tx * 4, y - ty * 4, 1.8)
  return ahead || behind
}

function bestArcWindow(
  samples: ArcSample[],
  wallDeg: number,
): { rate: number; raw: number; leafDeg: number; start: number; size: number } | null {
  const bins = samples.length
  const dilated = samples.map((_, i) => {
    for (let k = -2; k <= 2; k++) {
      const s = samples[(i + k + bins) % bins]
      if (s.free && s.hit) return true
    }
    return false
  })
  let best: { rate: number; raw: number; leafDeg: number; start: number; size: number } | null = null
  const minSize = Math.round(68 / 3)
  const maxSize = Math.round(112 / 3)
  for (let size = minSize; size <= maxSize; size++) {
    for (let s = 0; s < bins; s++) {
      let hit = 0
      let rawHit = 0
      let free = 0
      let runs = 0
      let maxRun = 0
      let curRun = 0
      let gapRun = 0
      let maxGap = 0
      let prev = false
      for (let k = 0; k < size; k++) {
        const sample = samples[(s + k) % bins]
        if (!sample.free) continue
        free++
        if (dilated[(s + k) % bins]) hit++
        if (sample.hit) {
          rawHit++
          if (!prev) {
            runs++
            curRun = 1
          } else curRun++
          if (curRun > maxRun) maxRun = curRun
          if (gapRun > maxGap) maxGap = gapRun
          gapRun = 0
          prev = true
        } else {
          gapRun++
          prev = false
        }
      }
      if (gapRun > maxGap) maxGap = gapRun
      if (free < size * 0.55) continue
      const rate = hit / free
      const raw = rawHit / free
      const solid = raw >= 0.62 && runs <= 2 && maxGap <= 4
      const dotted = raw >= 0.3 && rate >= 0.75 && runs >= 4 && maxGap <= 4 && maxRun * 2 <= rawHit
      if (!solid && !dotted) continue
      const startDeg = s * 3
      const endDeg = ((s + size - 1) * 3) % 360
      const edgeTol = solid ? 24 : 34
      const d0 = circDistDeg(startDeg, wallDeg)
      const d1 = circDistDeg(endDeg, wallDeg)
      if (d0 > edgeTol && d1 > edgeTol) continue
      const leafDeg = d0 <= d1 ? endDeg : startDeg
      if (!best || rate > best.rate) best = { rate, raw, leafDeg, start: s, size }
    }
  }
  return best
}

function oppositeRaw(samples: ArcSample[], start: number, size: number): number {
  const bins = samples.length
  const opp = (start + Math.round(bins / 2)) % bins
  let hit = 0
  let free = 0
  for (let k = 0; k < size; k++) {
    const sample = samples[(opp + k) % bins]
    if (!sample.free) continue
    free++
    if (sample.hit) hit++
  }
  return free === 0 ? 0 : hit / free
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
    if (inkNear(ink, w, h, x, y, 2.1)) {
      inkCount++
      last = t
      gap = 0
    } else {
      gap++
      if (gap > 10 && t > radius * 0.35) break
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
    for (let k = 0; k < size; k++) if (hits[(s + k) % hits.length].hit) hit++
    best = Math.max(best, hit / size)
  }
  return best
}

function toDeg(rad: number): number {
  let deg = (rad * 180) / Math.PI
  if (deg < 0) deg += 360
  return deg
}

export type PlacedSwing = SwingHit & { openingA: Vec2; openingB: Vec2 }
export type PlacedSliding = SlidingHit & { openingA: Vec2; openingB: Vec2 }

/** 牆墨不斷時，門扇加約四分之一圓弧仍算平開門，開口沿牆挖除。缺門扇或缺圓弧就不收。 */
export function findSwingsOnWalls(
  ink: Uint8Array,
  width: number,
  height: number,
  fragments: WallFragment[],
  mpp: number,
): PlacedSwing[] {
  const radii = doorRadiiPx(mpp)
  if (radii.length === 0) return []
  const found: PlacedSwing[] = []
  for (const frag of fragments) {
    if (!axisAligned(frag)) continue
    const len = dist(frag.a, frag.b)
    if (len < radii[0] * 0.75) continue
    const dir = norm(sub(frag.b, frag.a))
    const step = Math.max(4, Math.round(radii[0] * 0.12))
    for (let t = 0; t <= len; t += step) {
      const hinge = { x: frag.a.x + dir.x * t, y: frag.a.y + dir.y * t }
      for (const radius of radii) {
        if (!roughArc(ink, width, height, hinge, radius)) continue
        for (const sign of [1, -1] as const) {
          const t2 = t + sign * radius
          const lo = Math.max(0, Math.min(t, t2))
          const hi = Math.min(len, Math.max(t, t2))
          if (hi - lo < radius * 0.62) continue
          const other = { x: frag.a.x + dir.x * t2, y: frag.a.y + dir.y * t2 }
          const gap: PixelGap = { a: hinge, b: other, thicknessPx: Math.max(frag.thicknessPx, 8) }
          const hit = evaluateSwing(ink, width, height, gap, radius)
          if (hit.status !== "swing") continue
          if (circleFill(ink, width, height, hit.hinge, radius) > 0.56) continue
          if (leafLiesOnWall(hit.hinge, hit.leafTip, fragments, frag)) continue
          if (arcSlides(ink, width, height, frag, dir, len, t, sign, radius)) continue
          found.push({ ...hit, openingA: hinge, openingB: other })
        }
      }
    }
  }
  return capSeparated(suppressByMidpoint(found))
}

/** 圓心沿牆移開半個門寬仍能配上圓弧，就是紋理，不是一樘門。 */
function arcSlides(
  ink: Uint8Array,
  width: number,
  height: number,
  frag: WallFragment,
  dir: Vec2,
  len: number,
  t: number,
  sign: 1 | -1,
  radius: number,
): boolean {
  const shift = radius * 0.42
  let checked = 0
  let slides = 0
  for (const dt of [-shift, shift]) {
    const t2 = t + dt
    const tOther = t2 + sign * radius
    const lo = Math.max(0, Math.min(t2, tOther))
    const hi = Math.min(len, Math.max(t2, tOther))
    if (hi - lo < radius * 0.62) continue
    checked++
    const hinge = { x: frag.a.x + dir.x * t2, y: frag.a.y + dir.y * t2 }
    const other = { x: frag.a.x + dir.x * tOther, y: frag.a.y + dir.y * tOther }
    const gap: PixelGap = { a: hinge, b: other, thicknessPx: Math.max(frag.thicknessPx, 8) }
    const hit = evaluateSwing(ink, width, height, gap, radius)
    if (hit.status === "swing") slides++
  }
  return checked === 0 || slides > 0
}

function capSeparated(found: PlacedSwing[]): PlacedSwing[] {
  const ranked = [...found].sort((a, b) => b.confidence - a.confidence)
  const kept: PlacedSwing[] = []
  for (const hit of ranked) {
    const mid = { x: (hit.openingA.x + hit.openingB.x) / 2, y: (hit.openingA.y + hit.openingB.y) / 2 }
    const len = dist(hit.openingA, hit.openingB)
    const close = kept.some((other) => {
      const mid2 = {
        x: (other.openingA.x + other.openingB.x) / 2,
        y: (other.openingA.y + other.openingB.y) / 2,
      }
      const otherLen = dist(other.openingA, other.openingB)
      return dist(mid, mid2) < Math.max(len, otherLen) * 0.9
    })
    if (!close) kept.push(hit)
  }
  return kept
}

/** 牆帶裡錯開的兩條短平行線是拉門。整道牆的雙線、以及對齊的窗線不算。 */
export function findSlidingsOnWalls(
  ink: Uint8Array,
  width: number,
  height: number,
  fragments: WallFragment[],
  mpp: number,
): PlacedSliding[] {
  const minLen = Math.max(24, 0.55 / mpp)
  const maxLen = Math.min(320, 3.1 / mpp)
  const found: PlacedSliding[] = []
  for (const frag of fragments) {
    if (!axisAligned(frag)) continue
    const len = dist(frag.a, frag.b)
    if (len < minLen * 0.8) continue
    const dir = norm(sub(frag.b, frag.a))
    const normal = { x: -dir.y, y: dir.x }
    const band = Math.max(frag.thicknessPx * 0.95, 12)
    const runs = parallelSegments(ink, width, height, frag.a, frag.b, band, minLen * 0.42)
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]
        const b = runs[j]
        const sep = Math.abs(a.offset - b.offset)
        if (sep < 3 || sep > 16) continue
        const lenA = a.t1 - a.t0
        const lenB = b.t1 - b.t0
        if (lenA < minLen * 0.4 || lenB < minLen * 0.4) continue
        if (lenA > maxLen || lenB > maxLen) continue
        if (lenA > len * 0.72 && lenB > len * 0.72) continue
        const overlap = overlapRatio(a, b)
        if (overlap < 0.2 || overlap > 0.8) continue
        const midA = (a.t0 + a.t1) / 2
        const midB = (b.t0 + b.t1) / 2
        const span0 = Math.min(a.t0, b.t0)
        const span1 = Math.max(a.t1, b.t1)
        const span = span1 - span0
        if (span < minLen || span > maxLen) continue
        if (span > len * 0.9) continue
        if (Math.abs(midA - midB) < span * 0.08) continue
        const midOff = (a.offset + b.offset) / 2
        if (Math.abs(midOff) > Math.max(frag.thicknessPx * 0.7, 8)) continue
        const openingA = { x: frag.a.x + dir.x * span0, y: frag.a.y + dir.y * span0 }
        const openingB = { x: frag.a.x + dir.x * span1, y: frag.a.y + dir.y * span1 }
        const openingPx = dist(openingA, openingB)
        if (arcStrength(ink, width, height, openingA, openingPx) > 0.32) continue
        if (arcStrength(ink, width, height, openingB, openingPx) > 0.32) continue
        const at = (run: (typeof runs)[0]) => {
          const p = (tt: number) => ({
            x: frag.a.x + dir.x * tt + normal.x * run.offset,
            y: frag.a.y + dir.y * tt + normal.y * run.offset,
          })
          return { a: p(run.t0), b: p(run.t1) }
        }
        const stagger = Math.abs(overlap - 0.45)
        found.push({
          status: "sliding",
          openingA,
          openingB,
          leafA: at(a),
          leafB: at(b),
          confidence: Math.round((0.78 - stagger * 0.2) * 100) / 100,
        })
      }
    }
  }
  return suppressByMidpoint(found)
}

function axisAligned(frag: WallFragment): boolean {
  const dx = Math.abs(frag.b.x - frag.a.x)
  const dy = Math.abs(frag.b.y - frag.a.y)
  if (dx < 4 || dy < 4) return true
  return dx / dy < 0.12 || dy / dx < 0.12
}

/** 門扇若貼在另一道牆上，那是牆線而不是門。 */
function leafLiesOnWall(
  hinge: Vec2,
  leafTip: Vec2,
  fragments: WallFragment[],
  self: WallFragment,
): boolean {
  const mid = { x: (hinge.x + leafTip.x) / 2, y: (hinge.y + leafTip.y) / 2 }
  const tip = leafTip
  for (const frag of fragments) {
    if (frag === self) continue
    const tol = Math.max(frag.thicknessPx * 0.65, 5)
    if (pointSegmentDist(mid, frag) < tol || pointSegmentDist(tip, frag) < tol) return true
  }
  return false
}

function pointSegmentDist(p: Vec2, frag: WallFragment): number {
  const dx = frag.b.x - frag.a.x
  const dy = frag.b.y - frag.a.y
  const len2 = dx * dx + dy * dy || 1
  let t = ((p.x - frag.a.x) * dx + (p.y - frag.a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const x = frag.a.x + dx * t
  const y = frag.a.y + dy * t
  return Math.hypot(p.x - x, p.y - y)
}

function doorRadiiPx(mpp: number): number[] {
  const radii: number[] = []
  for (const meters of [0.7, 0.84, 0.98, 1.12]) {
    const px = meters / Math.max(mpp, 1e-6)
    if (px >= 28 && px <= 150) radii.push(px)
  }
  return radii
}

function roughArc(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
): boolean {
  let hits = 0
  for (let deg = 0; deg < 360; deg += 30) {
    const ang = (deg * Math.PI) / 180
    if (inkNear(ink, w, h, hinge.x + Math.cos(ang) * radius, hinge.y + Math.sin(ang) * radius, 2.4)) {
      hits++
    }
  }
  return hits >= 2 && hits <= 7
}

function circleFill(
  ink: Uint8Array,
  w: number,
  h: number,
  hinge: Vec2,
  radius: number,
): number {
  const hits = sampleArc(ink, w, h, hinge, radius)
  let n = 0
  let free = 0
  for (const hit of hits) {
    if (!hit.free) continue
    free++
    if (hit.hit) n++
  }
  return free === 0 ? 0 : n / free
}

function suppressByMidpoint<T extends { openingA: Vec2; openingB: Vec2; confidence: number }>(
  found: T[],
): T[] {
  const ranked = [...found].sort((a, b) => b.confidence - a.confidence || dist(b.openingA, b.openingB) - dist(a.openingA, a.openingB))
  const kept: T[] = []
  for (const hit of ranked) {
    const clash = kept.some((other) => openingsOverlap(hit.openingA, hit.openingB, other.openingA, other.openingB))
    if (!clash) kept.push(hit)
  }
  return kept
}

function openingsOverlap(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const ab = dist(a, b)
  const cd = dist(c, d)
  const mid1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const mid2 = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }
  if (dist(mid1, mid2) > Math.max(ab, cd) * 0.95) return false
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const dir = { x: dx / len, y: dy / len }
  const proj = (p: Vec2) => (p.x - a.x) * dir.x + (p.y - a.y) * dir.y
  const perp = (p: Vec2) => Math.abs((p.x - a.x) * -dir.y + (p.y - a.y) * dir.x)
  if (perp(c) > 14 || perp(d) > 14) return dist(mid1, mid2) < Math.max(16, Math.min(ab, cd) * 0.45)
  const overlap =
    Math.min(Math.max(proj(a), proj(b)), Math.max(proj(c), proj(d))) -
    Math.max(Math.min(proj(a), proj(b)), Math.min(proj(c), proj(d)))
  const shorter = Math.min(ab, cd)
  if (overlap > shorter * 0.15) return true
  return overlap > -Math.max(16, shorter * 0.22) && perp(c) < 10 && perp(d) < 10
}
