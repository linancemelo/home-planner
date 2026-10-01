import type { Vec2 } from "../../types/floorplan.ts"
import { add, dist, mul, norm, overlap1d, sub, undirectedAngleDiff } from "../geometry.ts"
import { inkAt } from "../ink.ts"
import { DEFAULT_WALL_THICKNESS_M, FALLBACK_METERS_PER_PIXEL } from "../units.ts"
import { detectLineSegments, type HoughSegment } from "./hough.ts"

export type WallFragment = {
  a: Vec2
  b: Vec2
  thicknessPx: number
  kind: "double" | "solid"
}

export type WallDetectResult = {
  fragments: WallFragment[]
  metersPerPixel: number
  scaleEstimated: boolean
  notes: string[]
  diagnostics: string[]
}

export function detectWallFragments(
  lines: Uint8Array,
  raw: Uint8Array,
  cleaned: Uint8Array,
  width: number,
  height: number,
): WallDetectResult {
  const diagnostics: string[] = []
  const notes: string[] = []
  const segments = detectLineSegments(lines, width, height)
  diagnostics.push(`霍夫直線段 ${segments.length} 條。`)

  const pairs = pairDoubleLines(segments, raw, width, height)
  diagnostics.push(
    `雙線配對候選 ${pairs.candidates}，採用 ${pairs.walls.length}，因間距不均或夾雜符號拒絕 ${pairs.rejectedInterior}。間距眾數 ${pairs.mode.toFixed(1)} px，拒絕原因 ${JSON.stringify(pairs.reasons)}。`,
  )
  if (pairs.rejectedInterior > 0) {
    notes.push("有線段因線間距不均或夾有文字／符號，未視為牆。")
  }

  const solids = detectSolidWalls(cleaned, width, height)
  diagnostics.push(`實心牆候選 ${solids.length} 條。`)

  const doubleFrags = pairs.walls
  const mergedSolids = solids.filter((solid) => !coveredByDouble(solid, doubleFrags))
  let fragments = dedupeFragments(
    [...doubleFrags, ...mergedSolids].map(snapNearAxis),
  )

  const scale = estimateScale(doubleFrags)
  if (!scale.estimated && mergedSolids.length > 0) {
    const thicks = mergedSolids.map((s) => s.thicknessPx).sort((a, b) => a - b)
    const mid = thicks[thicks.length >> 1]
    if (mid >= 5 && mid <= 40) {
      scale.metersPerPixel = DEFAULT_WALL_THICKNESS_M / mid
      scale.estimated = true
      scale.fromSolid = true
    }
  }

  if (!scale.estimated) {
    notes.push(
      `未能從雙線牆估計比例，已改用預設每像素 ${FALLBACK_METERS_PER_PIXEL} m，比例同樣不可採信。`,
    )
    diagnostics.push("比例尺退回預設值。")
  } else if (scale.fromSolid) {
    diagnostics.push(
      `比例由實心牆厚 ${DEFAULT_WALL_THICKNESS_M} m 假設反推，每像素 ${scale.metersPerPixel.toFixed(5)} m。`,
    )
  } else {
    diagnostics.push(
      `雙線間距中位數 ${scale.medianSepPx.toFixed(2)} px，假設牆厚 ${DEFAULT_WALL_THICKNESS_M} m，每像素 ${scale.metersPerPixel.toFixed(5)} m。`,
    )
  }

  const mpp = scale.estimated ? scale.metersPerPixel : FALLBACK_METERS_PER_PIXEL
  const minPx = Math.max(10, (0.22 / mpp) | 0)
  fragments = mergeColinearFragments(fragments).filter((f) => dist(f.a, f.b) >= minPx)

  return {
    fragments,
    metersPerPixel: mpp,
    scaleEstimated: scale.estimated,
    notes,
    diagnostics,
  }
}

function estimateScale(walls: WallFragment[]): {
  estimated: boolean
  metersPerPixel: number
  medianSepPx: number
  fromSolid: boolean
} {
  if (walls.length === 0) {
    return {
      estimated: false,
      metersPerPixel: FALLBACK_METERS_PER_PIXEL,
      medianSepPx: 0,
      fromSolid: false,
    }
  }
  const seps = walls.map((w) => w.thicknessPx).sort((a, b) => a - b)
  const median = seps[seps.length >> 1]
  if (median < 4 || median > 48) {
    return {
      estimated: false,
      metersPerPixel: FALLBACK_METERS_PER_PIXEL,
      medianSepPx: median,
      fromSolid: false,
    }
  }
  return {
    estimated: true,
    metersPerPixel: DEFAULT_WALL_THICKNESS_M / median,
    medianSepPx: median,
    fromSolid: false,
  }
}

function pairDoubleLines(
  segments: HoughSegment[],
  raw: Uint8Array,
  width: number,
  height: number,
): {
  walls: WallFragment[]
  rejectedInterior: number
  candidates: number
  reasons: Record<string, number>
  mode: number
} {
  type Candidate = { wall: WallFragment; sep: number; overlap: number }
  const rough: Candidate[] = []

  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i]
      const b = segments[j]
      if (undirectedAngleDiff(a.theta, b.theta) > 0.045) continue
      const sep = Math.abs(a.rho - b.rho)
      if (sep < 5 || sep > 42) continue
      const built = buildCenterline(a, b)
      if (!built) continue
      if (built.overlap < 28) continue
      rough.push({
        wall: {
          a: built.a,
          b: built.b,
          thicknessPx: built.sep,
          kind: "double",
        },
        sep: built.sep,
        overlap: built.overlap,
      })
    }
  }

  if (rough.length === 0) {
    return { walls: [], rejectedInterior: 0, candidates: 0, reasons: {}, mode: 0 }
  }

  const mode = dominantSep(rough)
  const lo = mode * 0.84
  const hi = mode * 1.18

  const walls: WallFragment[] = []
  let rejectedInterior = 0
  const reasons: Record<string, number> = {}
  const ranked = rough
    .filter((c) => c.sep >= lo && c.sep <= hi)
    .sort((a, b) => b.overlap - a.overlap)

  for (const cand of ranked) {
    const verdict = inspectGap(raw, width, height, cand.wall, cand.sep)
    if (verdict !== "ok") {
      if ((verdict === "clutter" || verdict === "uneven") && cand.overlap >= 80) rejectedInterior++
      reasons[verdict] = (reasons[verdict] ?? 0) + 1
      continue
    }
    if (dedupeFragments([...walls, cand.wall]).length === walls.length) continue
    walls.push(cand.wall)
  }

  return { walls, rejectedInterior, candidates: rough.length, reasons, mode }
}

function dominantSep(cands: { sep: number; overlap: number }[]): number {
  const long = cands.filter((c) => c.overlap >= 90)
  const pool = long.length >= 2 ? long : cands
  const bins = new Map<number, number>()
  for (const cand of pool) {
    const key = Math.round(cand.sep)
    bins.set(key, (bins.get(key) ?? 0) + cand.overlap)
  }
  let best = 12
  let bestWeight = -1
  for (const [key, weight] of bins) {
    if (weight > bestWeight) {
      bestWeight = weight
      best = key
    }
  }
  return best
}

function buildCenterline(
  a: HoughSegment,
  b: HoughSegment,
): { a: Vec2; b: Vec2; sep: number; overlap: number } | null {
  const theta = a.theta
  const dirX = -Math.sin(theta)
  const dirY = Math.cos(theta)
  const dir = { x: dirX, y: dirY }
  const proj = (p: Vec2) => p.x * dir.x + p.y * dir.y
  const a0 = Math.min(proj(a.a), proj(a.b))
  const a1 = Math.max(proj(a.a), proj(a.b))
  const b0 = Math.min(proj(b.a), proj(b.b))
  const b1 = Math.max(proj(b.a), proj(b.b))
  const overlap = overlap1d(a0, a1, b0, b1)
  const shorter = Math.min(a1 - a0, b1 - b0)
  if (overlap < shorter * 0.55) return null
  const t0 = Math.max(a0, b0)
  const t1 = Math.min(a1, b1)

  const on = (seg: HoughSegment, t: number) => {
    const tRef = proj(seg.a)
    return add(seg.a, mul(dir, t - tRef))
  }
  const p0 = {
    x: (on(a, t0).x + on(b, t0).x) / 2,
    y: (on(a, t0).y + on(b, t0).y) / 2,
  }
  const p1 = {
    x: (on(a, t1).x + on(b, t1).x) / 2,
    y: (on(a, t1).y + on(b, t1).y) / 2,
  }
  const sep = (dist(on(a, (t0 + t1) / 2), on(b, (t0 + t1) / 2)) + Math.abs(a.rho - b.rho)) / 2
  return { a: p0, b: p1, sep, overlap }
}

function inspectGap(
  raw: Uint8Array,
  width: number,
  height: number,
  wall: WallFragment,
  sep: number,
): "ok" | "reject" | "thin" | "uneven" | "clutter" | "broken" {
  const delta = sub(wall.b, wall.a)
  const length = Math.hypot(delta.x, delta.y)
  if (length < 20) return "thin"
  const dir = norm(delta)
  const normal = { x: -dir.y, y: dir.x }
  const steps = Math.max(8, Math.floor(length / 4))
  const seps: number[] = []
  let interiorInk = 0
  let interiorTotal = 0

  for (let i = 0; i < steps; i++) {
    const t = ((i + 0.5) / steps) * length
    const cx = wall.a.x + dir.x * t
    const cy = wall.a.y + dir.y * t
    const half = sep / 2
    const p1 = { x: cx + normal.x * half, y: cy + normal.y * half }
    const p2 = { x: cx - normal.x * half, y: cy - normal.y * half }
    const c1 = localOffset(raw, width, height, p1, normal, dir)
    const c2 = localOffset(raw, width, height, p2, normal, dir)
    if (c1 === null || c2 === null) continue
    seps.push(Math.abs(c1 - c2))

    const samples = Math.max(3, Math.round(sep))
    for (let s = 0; s < samples; s++) {
      const u = (s + 0.5) / samples
      if (u < 0.22 || u > 0.78) continue
      const x = p1.x + (p2.x - p1.x) * u
      const y = p1.y + (p2.y - p1.y) * u
      interiorTotal++
      if (inkAt(raw, width, height, x, y)) interiorInk++
    }
  }

  if (seps.length < steps * 0.45) return "broken"
  const sortedSeps = [...seps].sort((p, q) => p - q)
  const mid = sortedSeps[sortedSeps.length >> 1]
  const deviations = seps.map((v) => Math.abs(v - mid)).sort((p, q) => p - q)
  const mad = deviations[deviations.length >> 1]
  if (mad > 2.6) return "uneven"

  const ratio = interiorTotal === 0 ? 0 : interiorInk / interiorTotal
  if (ratio > 0.12 && ratio < 0.68) return "clutter"
  return "ok"
}

function localOffset(
  ink: Uint8Array,
  w: number,
  h: number,
  origin: Vec2,
  normal: Vec2,
  dir: Vec2,
): number | null {
  let weight = 0
  let acc = 0
  for (let dn = -3; dn <= 3; dn++) {
    for (let dt = -1; dt <= 1; dt++) {
      const x = origin.x + normal.x * dn + dir.x * dt
      const y = origin.y + normal.y * dn + dir.y * dt
      if (!inkAt(ink, w, h, x, y)) continue
      weight++
      acc += dn
    }
  }
  if (weight === 0) return null
  return acc / weight
}

function detectSolidWalls(ink: Uint8Array, w: number, h: number): WallFragment[] {
  const horizontal: WallFragment[] = []
  const seedsH: { x: number; y: number; t: number }[] = []
  for (let x = 0; x < w; x++) {
    let y = 0
    while (y < h) {
      if (!ink[y * w + x]) {
        y++
        continue
      }
      let y2 = y
      while (y2 < h && ink[y2 * w + x]) y2++
      const run = y2 - y
      if (run >= 5 && run <= 36) seedsH.push({ x, y: (y + y2 - 1) / 2, t: run })
      y = y2
    }
  }
  horizontal.push(...clusterAxis(seedsH, "h"))

  const seedsV: { x: number; y: number; t: number }[] = []
  for (let y = 0; y < h; y++) {
    let x = 0
    const row = y * w
    while (x < w) {
      if (!ink[row + x]) {
        x++
        continue
      }
      let x2 = x
      while (x2 < w && ink[row + x2]) x2++
      const run = x2 - x
      if (run >= 5 && run <= 36) seedsV.push({ x: (x + x2 - 1) / 2, y, t: run })
      x = x2
    }
  }
  const vertical = clusterAxis(seedsV, "v")
  return [...horizontal, ...vertical].filter((f) => dist(f.a, f.b) >= 36)
}

function clusterAxis(
  seeds: { x: number; y: number; t: number }[],
  orientation: "h" | "v",
): WallFragment[] {
  if (seeds.length === 0) return []
  const key = orientation === "h" ? "y" : "x"
  const along = orientation === "h" ? "x" : "y"
  seeds.sort((a, b) => a[key] - b[key] || a[along] - b[along])
  const used = new Uint8Array(seeds.length)
  const out: WallFragment[] = []

  for (let i = 0; i < seeds.length; i++) {
    if (used[i]) continue
    const band: { x: number; y: number; t: number }[] = [seeds[i]]
    used[i] = 1
    const origin = seeds[i][key]
    for (let j = i + 1; j < seeds.length; j++) {
      if (seeds[j][key] - origin > 2.4) break
      if (used[j]) continue
      if (Math.abs(seeds[j][key] - origin) <= 1.7) {
        band.push(seeds[j])
        used[j] = 1
      }
    }
    band.sort((a, b) => a[along] - b[along])
    let start = 0
    for (let k = 1; k <= band.length; k++) {
      if (k === band.length || band[k][along] - band[k - 1][along] > 8) {
        const slice = band.slice(start, k)
        if (slice.length >= 28) {
          const fixed = slice.reduce((s, p) => s + p[key], 0) / slice.length
          const thick = slice.reduce((s, p) => s + p.t, 0) / slice.length
          const a0 = slice[0][along]
          const a1 = slice[slice.length - 1][along]
          out.push({
            a:
              orientation === "h"
                ? { x: a0, y: fixed }
                : { x: fixed, y: a0 },
            b:
              orientation === "h"
                ? { x: a1, y: fixed }
                : { x: fixed, y: a1 },
            thicknessPx: thick,
            kind: "solid",
          })
        }
        start = k
      }
    }
  }
  return out
}

/** 霍夫 1° 量化會把正交牆拉斜幾個像素，導致同一道牆的左右段對不齊、開口消失。 */
function snapNearAxis(frag: WallFragment): WallFragment {
  const dx = frag.b.x - frag.a.x
  const dy = frag.b.y - frag.a.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  const slopeLimit = Math.tan((1.3 * Math.PI) / 180)
  if (adx >= 36 && ady / adx < slopeLimit) {
    const y = (frag.a.y + frag.b.y) / 2
    return { ...frag, a: { x: frag.a.x, y }, b: { x: frag.b.x, y } }
  }
  if (ady >= 36 && adx / ady < slopeLimit) {
    const x = (frag.a.x + frag.b.x) / 2
    return { ...frag, a: { x, y: frag.a.y }, b: { x, y: frag.b.y } }
  }
  return frag
}

/** 把同一條牆上被角度量化切開的碎片接回去。門窗缺口（大於約 24px）留著。 */
function mergeColinearFragments(fragments: WallFragment[]): WallFragment[] {
  let current = fragments.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length && !changed; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const merged = mergeFragmentPair(current[i], current[j])
        if (!merged) continue
        current = current.filter((_, idx) => idx !== i && idx !== j)
        current.push(merged)
        changed = true
        break
      }
    }
  }
  return current
}

function mergeFragmentPair(a: WallFragment, b: WallFragment): WallFragment | null {
  const angA = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x)
  const angB = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x)
  if (undirectedAngleDiff(angA, angB) > 0.12) return null
  const dir = norm(sub(a.b, a.a))
  const origin = a.a
  const normal = { x: -dir.y, y: dir.x }
  const perp = (p: Vec2) => Math.abs((p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y)
  if (perp(b.a) > 4 || perp(b.b) > 4) return null
  const proj = (p: Vec2) => (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y
  const a0 = Math.min(proj(a.a), proj(a.b))
  const a1 = Math.max(proj(a.a), proj(a.b))
  const b0 = Math.min(proj(b.a), proj(b.b))
  const b1 = Math.max(proj(b.a), proj(b.b))
  const gap = b0 > a1 ? b0 - a1 : a0 > b1 ? a0 - b1 : 0
  if (gap > 24) return null
  const tMin = Math.min(a0, b0)
  const tMax = Math.max(a1, b1)
  return {
    a: add(origin, mul(dir, tMin)),
    b: add(origin, mul(dir, tMax)),
    thicknessPx: (a.thicknessPx + b.thicknessPx) / 2,
    kind: a.kind === "solid" || b.kind === "solid" ? "solid" : "double",
  }
}

function coveredByDouble(solid: WallFragment, doubles: WallFragment[]): boolean {
  return doubles.some((d) => fragmentsOverlap(solid, d, 5, 0.55))
}

export function dedupeFragments(fragments: WallFragment[]): WallFragment[] {
  const ranked = [...fragments].sort((a, b) => dist(b.a, b.b) - dist(a.a, a.b))
  const kept: WallFragment[] = []
  for (const frag of ranked) {
    if (kept.some((other) => fragmentsOverlap(frag, other, 3.5, 0.62))) continue
    kept.push(frag)
  }
  return kept
}

function fragmentsOverlap(a: WallFragment, b: WallFragment, perpTol: number, overlapRatio: number): boolean {
  const angA = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x)
  const angB = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x)
  if (undirectedAngleDiff(angA, angB) > 0.12) return false
  const dir = norm(sub(b.b, b.a))
  const proj = (p: Vec2) => p.x * dir.x + p.y * dir.y
  const normal = { x: -dir.y, y: dir.x }
  const perp = (p: Vec2) => (p.x - b.a.x) * normal.x + (p.y - b.a.y) * normal.y
  if (Math.abs(perp(a.a)) > perpTol || Math.abs(perp(a.b)) > perpTol) return false
  const overlap = overlap1d(proj(a.a), proj(a.b), proj(b.a), proj(b.b))
  const shorter = Math.min(dist(a.a, a.b), dist(b.a, b.b))
  return overlap > shorter * overlapRatio
}

export type PixelGap = {
  a: Vec2
  b: Vec2
  thicknessPx: number
}

/** 把共線牆段排好，找出中間夠大的缺口。缺口兩側仍是同一道牆。 */
export function findPixelGaps(fragments: WallFragment[], mpp: number): PixelGap[] {
  const groups = groupColinear(fragments)
  const minGap = Math.max(20, 0.45 / mpp)
  const maxGap = Math.max(minGap + 10, 3.4 / mpp)
  const gaps: PixelGap[] = []

  for (const group of groups) {
    const longest = group.reduce((best, frag) =>
      dist(frag.a, frag.b) > dist(best.a, best.b) ? frag : best,
    )
    const dir = norm(sub(longest.b, longest.a))
    const origin = longest.a
    const proj = (p: Vec2) => (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y
    const spans = group
      .map((frag) => {
        const t0 = proj(frag.a)
        const t1 = proj(frag.b)
        return {
          t0: Math.min(t0, t1),
          t1: Math.max(t0, t1),
          thickness: frag.thicknessPx,
        }
      })
      .sort((a, b) => a.t0 - b.t0)

    const merged: { t0: number; t1: number; thickness: number }[] = []
    for (const span of spans) {
      const last = merged[merged.length - 1]
      if (last && span.t0 - last.t1 < 14) {
        last.t1 = Math.max(last.t1, span.t1)
        last.thickness = (last.thickness + span.thickness) / 2
      } else {
        merged.push({ ...span })
      }
    }

    for (let i = 1; i < merged.length; i++) {
      const gap = merged[i].t0 - merged[i - 1].t1
      if (gap < minGap || gap > maxGap) continue
      const tA = merged[i - 1].t1
      const tB = merged[i].t0
      gaps.push({
        a: add(origin, mul(dir, tA)),
        b: add(origin, mul(dir, tB)),
        thicknessPx: (merged[i - 1].thickness + merged[i].thickness) / 2,
      })
    }
  }
  return gaps
}

function groupColinear(fragments: WallFragment[]): WallFragment[][] {
  const used = new Set<number>()
  const groups: WallFragment[][] = []
  for (let i = 0; i < fragments.length; i++) {
    if (used.has(i)) continue
    const group = [fragments[i]]
    used.add(i)
    let grew = true
    while (grew) {
      grew = false
      for (let j = 0; j < fragments.length; j++) {
        if (used.has(j)) continue
        if (group.some((frag) => colinearPx(frag, fragments[j]))) {
          group.push(fragments[j])
          used.add(j)
          grew = true
        }
      }
    }
    groups.push(group)
  }
  return groups
}

function colinearPx(a: WallFragment, b: WallFragment): boolean {
  const angA = Math.atan2(a.b.y - a.a.y, a.b.x - a.a.x)
  const angB = Math.atan2(b.b.y - b.a.y, b.b.x - b.a.x)
  if (undirectedAngleDiff(angA, angB) > 0.1) return false
  const dir = norm(sub(a.b, a.a))
  const normal = { x: -dir.y, y: dir.x }
  const perp = (p: Vec2) => Math.abs((p.x - a.a.x) * normal.x + (p.y - a.a.y) * normal.y)
  if (perp(b.a) > 4 || perp(b.b) > 4) return false
  const proj = (p: Vec2) => (p.x - a.a.x) * dir.x + (p.y - a.a.y) * dir.y
  const a0 = Math.min(proj(a.a), proj(a.b))
  const a1 = Math.max(proj(a.a), proj(a.b))
  const b0 = Math.min(proj(b.a), proj(b.b))
  const b1 = Math.max(proj(b.a), proj(b.b))
  const gap = Math.max(b0, a0) - Math.min(b1, a1)
  const separation = b0 > a1 ? b0 - a1 : a0 > b1 ? a0 - b1 : 0
  return separation < 360 || gap < 0
}
