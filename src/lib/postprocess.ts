import type { Door, Excavation, Floorplan, Vec2, Wall, Window } from "../types/floorplan.ts"
import {
  add,
  canonicalize,
  dist,
  mul,
  norm,
  openDirectionOf,
  projectPoint,
  roundVec,
  sub,
  undirectedAngleDiff,
} from "./geometry.ts"
import { doorStableId, wallStableId, windowStableId } from "./ids.ts"
import {
  DEFAULT_CEILING_HEIGHT_M,
  DEFAULT_COORDINATE_ORIGIN,
  DEFAULT_SILL_HEIGHT_M,
  DEFAULT_WALL_THICKNESS_M,
  MIN_SEGMENT_LENGTH_M,
  OPENING_PROJECT_TOLERANCE_PX,
} from "./units.ts"

export type DraftWall = {
  a: Vec2
  b: Vec2
  thicknessM: number
  thicknessAssumed: boolean
}

export type DraftDoor = {
  kind: "swing" | "sliding"
  openingA: Vec2
  openingB: Vec2
  confidence: number
  hinge?: Vec2
  leafTip?: Vec2
  leafLengthM?: number
  sliding?: Door["sliding"]
}

export type DraftWindow = {
  openingA: Vec2
  openingB: Vec2
  confidence: number
}

export function postprocess(input: {
  walls: DraftWall[]
  doors: DraftDoor[]
  windows: DraftWindow[]
  notes: string[]
  metersPerPixel: number
  scaleEstimated: boolean
  sourceName: string
  imageWidthPx: number
  imageHeightPx: number
}): { floorplan: Floorplan; excavations: Excavation[] } {
  const notes = dedupe(input.notes)
  let walls = input.walls.map((w) => ({ ...w }))
  const doors = input.doors.map((d) => ({ ...d }))
  const windows = input.windows.map((w) => ({ ...w }))

  const furniture = rejectFurniture(walls)
  if (furniture.reject.size > 0) {
    walls = walls.filter((_, i) => !furniture.reject.has(i))
    notes.push("已略過疑似家具的封閉小矩形，不視為牆。")
  }

  const openings = [
    ...doors.map((d) => ({ a: d.openingA, b: d.openingB, kind: "door" as const })),
    ...windows.map((w) => ({ a: w.openingA, b: w.openingB, kind: "window" as const })),
  ]
  walls = walls.filter((w) => {
    if (dist(w.a, w.b) >= MIN_SEGMENT_LENGTH_M - 1e-6) return true
    return openings.some(
      (op) =>
        dist(w.a, op.a) < 0.25 ||
        dist(w.a, op.b) < 0.25 ||
        dist(w.b, op.a) < 0.25 ||
        dist(w.b, op.b) < 0.25,
    )
  })
  walls = mergeColinear(walls, openings, notes, input.metersPerPixel)

  const projected = projectAndExcavate(walls, doors, windows, input.metersPerPixel, notes)

  const wallRecords: Wall[] = projected.pieces.map((piece) => {
    const [a, b] = canonicalize(roundVec(piece.a), roundVec(piece.b))
    const thicknessM = roundM4(piece.thicknessM || DEFAULT_WALL_THICKNESS_M)
    return {
      id: wallStableId(a, b, thicknessM),
      a,
      b,
      thicknessM,
      thicknessAssumed: true,
    }
  })

  const doorRecords: Door[] = []
  for (const door of projected.doors) {
    const piece = wallRecords[door.pieceIndex]
    if (!piece) continue
    const [oa, ob] = canonicalize(roundVec(door.openingA), roundVec(door.openingB))
    const openingLen = dist(oa, ob)
    if (door.kind === "swing" && door.hinge && door.leafTip && door.leafLengthM) {
      if (Math.abs(door.leafLengthM - openingLen) > openingLen * 0.1 + 0.02) {
        notes.push("疑似平開門但特徵不足")
        continue
      }
      const hinge = roundVec(door.hinge)
      const leafTip = door.leafTip
      doorRecords.push({
        id: doorStableId("swing", oa, ob, hinge),
        kind: "swing",
        wallId: piece.id,
        opening: { a: oa, b: ob },
        confidence: clamp01(door.confidence),
        swing: {
          hinge,
          leafLengthM: roundM4(door.leafLengthM),
          openDirection: openDirectionOf(piece.a, piece.b, hinge, leafTip),
          arcQuarter: true,
        },
      })
    } else if (door.kind === "sliding" && door.sliding) {
      doorRecords.push({
        id: doorStableId("sliding", oa, ob, null),
        kind: "sliding",
        wallId: piece.id,
        opening: { a: oa, b: ob },
        confidence: clamp01(door.confidence),
        sliding: {
          leafA: {
            a: roundVec(door.sliding.leafA.a),
            b: roundVec(door.sliding.leafA.b),
          },
          leafB: {
            a: roundVec(door.sliding.leafB.a),
            b: roundVec(door.sliding.leafB.b),
          },
        },
      })
    }
  }

  const windowRecords: Window[] = []
  for (const win of projected.windows) {
    const piece = wallRecords[win.pieceIndex]
    if (!piece) continue
    const [oa, ob] = canonicalize(roundVec(win.openingA), roundVec(win.openingB))
    windowRecords.push({
      id: windowStableId(oa, ob),
      wallId: piece.id,
      opening: { a: oa, b: ob },
      confidence: clamp01(win.confidence),
      sillHeightM: DEFAULT_SILL_HEIGHT_M,
      sillHeightAssumed: true,
    })
  }

  sortWalls(wallRecords)
  doorRecords.sort((a, b) => a.opening.a.x - b.opening.a.x || a.opening.a.y - b.opening.a.y)
  windowRecords.sort((a, b) => a.opening.a.x - b.opening.a.x || a.opening.a.y - b.opening.a.y)

  const confidence = scoreConfidence(
    wallRecords.length,
    doorRecords,
    windowRecords,
    notes,
    input.scaleEstimated,
  )

  const floorplan: Floorplan = {
    version: 1,
    meta: {
      sourceName: input.sourceName,
      imageWidthPx: input.imageWidthPx,
      imageHeightPx: input.imageHeightPx,
      metersPerPixel: roundM4(input.metersPerPixel),
      scaleTrusted: false,
      coordinateOrigin: DEFAULT_COORDINATE_ORIGIN,
      ceilingHeightM: DEFAULT_CEILING_HEIGHT_M,
      ceilingHeightAssumed: true,
      detectionConfidence: confidence,
      notes: dedupe(notes),
    },
    walls: wallRecords,
    doors: doorRecords,
    windows: windowRecords,
  }

  return { floorplan, excavations: projected.excavations }
}

function rejectFurniture(walls: DraftWall[]): { reject: Set<number> } {
  const reject = new Set<number>()
  const n = walls.length
  const neighbors: number[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (!endsMeet(walls[i], walls[j])) continue
      const ang = undirectedAngleDiff(angleOf(walls[i]), angleOf(walls[j]))
      if (ang < 0.5) continue
      neighbors[i].push(j)
      neighbors[j].push(i)
    }
  }

  for (let i = 0; i < n; i++) {
    for (const j of neighbors[i]) {
      if (j <= i) continue
      for (const k of neighbors[j]) {
        if (k === i) continue
        for (const l of neighbors[k]) {
          if (l === i || l === j) continue
          if (!neighbors[l].includes(i)) continue
          const cycle = [i, j, k, l]
          if (!cycle.every((id) => neighbors[id].length === 2)) continue
          const lens = cycle.map((id) => dist(walls[id].a, walls[id].b))
          const maxL = Math.max(...lens)
          const minL = Math.min(...lens)
          if (maxL < 2.05 && minL < 1.7) {
            for (const id of cycle) reject.add(id)
          }
        }
      }
    }
  }
  return { reject }
}

function endsMeet(a: DraftWall, b: DraftWall): boolean {
  const tol = 0.18
  return (
    dist(a.a, b.a) < tol ||
    dist(a.a, b.b) < tol ||
    dist(a.b, b.a) < tol ||
    dist(a.b, b.b) < tol
  )
}

function angleOf(w: DraftWall): number {
  return Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x)
}

function mergeColinear(
  walls: DraftWall[],
  openings: { a: Vec2; b: Vec2 }[],
  notes: string[],
  mpp: number,
): DraftWall[] {
  let current = walls.slice()
  let changed = true
  while (changed) {
    changed = false
    for (let i = 0; i < current.length && !changed; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const merged = tryMerge(current[i], current[j], openings, notes, mpp)
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

function tryMerge(
  a: DraftWall,
  b: DraftWall,
  openings: { a: Vec2; b: Vec2 }[],
  notes: string[],
  mpp: number,
): DraftWall | null {
  if (undirectedAngleDiff(angleOf(a), angleOf(b)) > 0.14) return null
  const longer = dist(a.a, a.b) >= dist(b.a, b.b) ? a : b
  const dir = norm(sub(longer.b, longer.a))
  const origin = longer.a
  const proj = (p: Vec2) => (p.x - origin.x) * dir.x + (p.y - origin.y) * dir.y
  const normal = { x: -dir.y, y: dir.x }
  const perp = (p: Vec2) => Math.abs((p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y)
  const perpTol = Math.max(0.08, mpp * 6)
  if ([a.a, a.b, b.a, b.b].some((p) => perp(p) > perpTol)) return null

  const ts = [proj(a.a), proj(a.b), proj(b.a), proj(b.b)]
  const spans = [
    [Math.min(proj(a.a), proj(a.b)), Math.max(proj(a.a), proj(a.b))],
    [Math.min(proj(b.a), proj(b.b)), Math.max(proj(b.a), proj(b.b))],
  ].sort((p, q) => p[0] - q[0])
  const gap = spans[1][0] - spans[0][1]
  if (gap > 4) return null

  if (gap > 0.35) {
    const occupied = openings.some((op) => openingInGap(op, origin, dir, spans[0][1], spans[1][0]))
    if (!occupied) notes.push("可能有未辨識開口")
  }

  const tMin = Math.min(...ts)
  const tMax = Math.max(...ts)
  return {
    a: add(origin, mul(dir, tMin)),
    b: add(origin, mul(dir, tMax)),
    thicknessM: (a.thicknessM + b.thicknessM) / 2,
    thicknessAssumed: true,
  }
}

function openingInGap(
  op: { a: Vec2; b: Vec2 },
  origin: Vec2,
  dir: Vec2,
  gap0: number,
  gap1: number,
): boolean {
  const mid = { x: (op.a.x + op.b.x) / 2, y: (op.a.y + op.b.y) / 2 }
  const t = (mid.x - origin.x) * dir.x + (mid.y - origin.y) * dir.y
  const normal = { x: -dir.y, y: dir.x }
  const perp = Math.abs((mid.x - origin.x) * normal.x + (mid.y - origin.y) * normal.y)
  return perp < 0.2 && t >= gap0 - 0.08 && t <= gap1 + 0.08
}

type Piece = DraftWall & { parent: number }

function projectAndExcavate(
  walls: DraftWall[],
  doors: DraftDoor[],
  windows: DraftWindow[],
  mpp: number,
  notes: string[],
): {
  pieces: Piece[]
  doors: (DraftDoor & { pieceIndex: number })[]
  windows: (DraftWindow & { pieceIndex: number })[]
  excavations: Excavation[]
} {
  const tol = OPENING_PROJECT_TOLERANCE_PX * mpp
  type Interval = { t0: number; t1: number; kind: "door" | "window"; index: number }
  const buckets: Interval[][] = walls.map(() => [])

  const assign = (
    openingA: Vec2,
    openingB: Vec2,
  ): { wallIndex: number; a: Vec2; b: Vec2 } | null => {
    let best: { wallIndex: number; dist: number; a: Vec2; b: Vec2; overlap: number } | null = null
    for (let i = 0; i < walls.length; i++) {
      const wall = walls[i]
      const pa = projectPoint(openingA, wall.a, wall.b)
      const pb = projectPoint(openingB, wall.a, wall.b)
      const mid = projectPoint(
        { x: (openingA.x + openingB.x) / 2, y: (openingA.y + openingB.y) / 2 },
        wall.a,
        wall.b,
      )
      const d = Math.max(pa.distance, pb.distance, mid.distance)
      if (d > tol + 0.02) continue
      const len = dist(wall.a, wall.b)
      const t0 = clamp(Math.min(pa.t, pb.t), -0.02, 1.02) * len
      const t1 = clamp(Math.max(pa.t, pb.t), -0.02, 1.02) * len
      const overlap = Math.min(t1, len) - Math.max(t0, 0)
      const openingLen = dist(openingA, openingB)
      if (overlap < openingLen * 0.5) continue
      if (!best || d < best.dist) {
        const dir = norm(sub(wall.b, wall.a))
        best = {
          wallIndex: i,
          dist: d,
          a: add(wall.a, mul(dir, Math.max(0, Math.min(pa.t, pb.t) * len))),
          b: add(wall.a, mul(dir, Math.max(0, Math.min(Math.max(pa.t, pb.t) * len, len)))),
          overlap,
        }
      }
    }
    if (!best) return null
    return { wallIndex: best.wallIndex, a: best.a, b: best.b }
  }

  const keptDoors: (DraftDoor & { wallIndex: number })[] = []
  doors.forEach((door) => {
    const hit = assign(door.openingA, door.openingB)
    if (!hit) {
      notes.push("有開口無法貼合牆段，已略過。")
      return
    }
    const wall = walls[hit.wallIndex]
    const len = dist(wall.a, wall.b)
    const ta = projectPoint(hit.a, wall.a, wall.b).t * len
    const tb = projectPoint(hit.b, wall.a, wall.b).t * len
    buckets[hit.wallIndex].push({
      t0: Math.min(ta, tb),
      t1: Math.max(ta, tb),
      kind: "door",
      index: keptDoors.length,
    })
    keptDoors.push({ ...door, openingA: hit.a, openingB: hit.b, wallIndex: hit.wallIndex })
  })

  const keptWindows: (DraftWindow & { wallIndex: number })[] = []
  windows.forEach((win) => {
    const hit = assign(win.openingA, win.openingB)
    if (!hit) {
      notes.push("有開口無法貼合牆段，已略過。")
      return
    }
    const wall = walls[hit.wallIndex]
    const len = dist(wall.a, wall.b)
    const ta = projectPoint(hit.a, wall.a, wall.b).t * len
    const tb = projectPoint(hit.b, wall.a, wall.b).t * len
    buckets[hit.wallIndex].push({
      t0: Math.min(ta, tb),
      t1: Math.max(ta, tb),
      kind: "window",
      index: keptWindows.length,
    })
    keptWindows.push({ ...win, openingA: hit.a, openingB: hit.b, wallIndex: hit.wallIndex })
  })

  const pieces: Piece[] = []
  const excavations: Excavation[] = []
  const pieceByParent: number[][] = walls.map(() => [])

  walls.forEach((wall, wallIndex) => {
    const len = dist(wall.a, wall.b)
    const dir = norm(sub(wall.b, wall.a))
    const intervals = mergeIntervals(buckets[wallIndex])
    let cursor = 0
    const at = (t: number) => add(wall.a, mul(dir, t))
    for (const interval of intervals) {
      if (interval.t0 - cursor >= MIN_SEGMENT_LENGTH_M) {
        const pieceIndex = pieces.length
        pieces.push({
          a: at(cursor),
          b: at(interval.t0),
          thicknessM: wall.thicknessM,
          thicknessAssumed: true,
          parent: wallIndex,
        })
        pieceByParent[wallIndex].push(pieceIndex)
      } else if (interval.t0 - cursor > 0.02) {
        notes.push("挖除開口後剩下短於 0.3 m 的牆段，已當雜訊刪除。")
      }
      excavations.push({
        a: roundVec(at(interval.t0)),
        b: roundVec(at(interval.t1)),
        kind: interval.kind,
      })
      cursor = interval.t1
    }
    if (len - cursor >= MIN_SEGMENT_LENGTH_M) {
      const pieceIndex = pieces.length
      pieces.push({
        a: at(cursor),
        b: at(len),
        thicknessM: wall.thicknessM,
        thicknessAssumed: true,
        parent: wallIndex,
      })
      pieceByParent[wallIndex].push(pieceIndex)
    } else if (len - cursor > 0.02 && intervals.length > 0) {
      notes.push("挖除開口後剩下短於 0.3 m 的牆段，已當雜訊刪除。")
    }
    if (intervals.length === 0 && len >= MIN_SEGMENT_LENGTH_M) {
      // already pushed above via len - cursor
    }
  })

  const nearestPiece = (wallIndex: number, point: Vec2): number => {
    let best = -1
    let bestD = Infinity
    for (const pieceIndex of pieceByParent[wallIndex]) {
      const piece = pieces[pieceIndex]
      const d = Math.min(dist(point, piece.a), dist(point, piece.b), pointSegmentDist(point, piece.a, piece.b))
      if (d < bestD) {
        bestD = d
        best = pieceIndex
      }
    }
    return best
  }

  const outDoors: (DraftDoor & { pieceIndex: number })[] = []
  for (const door of keptDoors) {
    const anchor = door.hinge ?? {
      x: (door.openingA.x + door.openingB.x) / 2,
      y: (door.openingA.y + door.openingB.y) / 2,
    }
    const pieceIndex = nearestPiece(door.wallIndex, anchor)
    if (pieceIndex < 0) {
      notes.push("有開口無法貼合牆段，已略過。")
      continue
    }
    outDoors.push({ ...door, pieceIndex })
  }

  const outWindows: (DraftWindow & { pieceIndex: number })[] = []
  for (const win of keptWindows) {
    const mid = {
      x: (win.openingA.x + win.openingB.x) / 2,
      y: (win.openingA.y + win.openingB.y) / 2,
    }
    const pieceIndex = nearestPiece(win.wallIndex, mid)
    if (pieceIndex < 0) {
      notes.push("有開口無法貼合牆段，已略過。")
      continue
    }
    outWindows.push({ ...win, pieceIndex })
  }

  return { pieces, doors: outDoors, windows: outWindows, excavations }
}

function mergeIntervals(items: { t0: number; t1: number; kind: "door" | "window"; index: number }[]) {
  const sorted = [...items].sort((a, b) => a.t0 - b.t0)
  const out: { t0: number; t1: number; kind: "door" | "window" }[] = []
  for (const item of sorted) {
    const last = out[out.length - 1]
    if (last && item.t0 <= last.t1 + 0.02) {
      last.t1 = Math.max(last.t1, item.t1)
    } else {
      out.push({ t0: item.t0, t1: item.t1, kind: item.kind })
    }
  }
  return out
}

function pointSegmentDist(p: Vec2, a: Vec2, b: Vec2): number {
  const proj = projectPoint(p, a, b)
  const t = Math.max(0, Math.min(1, proj.t))
  const ab = sub(b, a)
  return dist(p, add(a, mul(ab, t)))
}

function scoreConfidence(
  wallCount: number,
  doors: { confidence?: number }[],
  windows: { confidence?: number }[],
  notes: string[],
  scaleEstimated: boolean,
): number {
  let c = 0.2
  if (wallCount >= 4) c += 0.28
  else if (wallCount >= 1) c += 0.12
  const features = [...doors, ...windows]
  if (features.length > 0) {
    const avg = features.reduce((s, f) => s + (f.confidence ?? 0.5), 0) / features.length
    c += 0.22 * avg
  }
  const soft = notes.filter(
    (n) => n.includes("疑似") || n.includes("未辨識") || n.includes("略過") || n.includes("未能"),
  ).length
  c -= Math.min(0.28, soft * 0.05)
  if (!scaleEstimated) c -= 0.1
  return Math.round(clamp01(Math.min(0.86, c)) * 100) / 100
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function roundM4(n: number): number {
  return Math.round(n * 10000) / 10000
}

function dedupe(notes: string[]): string[] {
  const out: string[] = []
  for (const note of notes) {
    if (!out.includes(note)) out.push(note)
  }
  return out
}

function sortWalls(walls: Wall[]): void {
  walls.sort((a, b) => a.a.x - b.a.x || a.a.y - b.a.y || a.b.x - b.b.x || a.b.y - b.b.y)
}
