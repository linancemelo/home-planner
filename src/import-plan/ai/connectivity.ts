/**
 * Room-access connectivity pass.
 *
 * Hard rules:
 * - every room needs door/opening access
 * - prefer removing short spurious walls that seal corridors over adding junk segments
 * - otherwise insert an opening on a shared wall and note it
 */
import type { Door, Floorplan, Vec2, Wall } from "../floorplan.ts"
import { add, canonicalize, dist, mul, norm, projectPoint, roundVec, sub, undirectedAngleDiff } from "../geometry.ts"
import { doorStableId } from "../ids.ts"
import { DEFAULT_WALL_THICKNESS_M, MIN_SEGMENT_LENGTH_M } from "../units.ts"

export type RoomAccessNode = {
  id: string
  label?: string
  /** Axis-aligned bounds used for adjacency (metres). */
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type ConnectivityResult = {
  floorplan: Floorplan
  notes: string[]
  /** Room ids that lacked access before the pass. */
  sealedRoomsFixed: string[]
  removedWallIds: string[]
  addedOpeningIds: string[]
}

const SHORT_SPURIOUS_M = 1.35
const OPENING_WIDTH_M = 0.9
const SHARE_TOL_M = 0.25

function wallLen(w: Wall): number {
  return dist(w.a, w.b)
}

function wallAngle(w: Wall): number {
  return Math.atan2(w.b.y - w.a.y, w.b.x - w.a.x)
}

function openingTouchesRoom(op: { a: Vec2; b: Vec2 }, room: RoomAccessNode): boolean {
  const mid = { x: (op.a.x + op.b.x) / 2, y: (op.a.y + op.b.y) / 2 }
  const onBoundary =
    (Math.abs(mid.x - room.minX) < SHARE_TOL_M || Math.abs(mid.x - room.maxX) < SHARE_TOL_M) &&
    mid.y >= room.minY - SHARE_TOL_M &&
    mid.y <= room.maxY + SHARE_TOL_M
  const onHBoundary =
    (Math.abs(mid.y - room.minY) < SHARE_TOL_M || Math.abs(mid.y - room.maxY) < SHARE_TOL_M) &&
    mid.x >= room.minX - SHARE_TOL_M &&
    mid.x <= room.maxX + SHARE_TOL_M
  const inside =
    mid.x >= room.minX - SHARE_TOL_M &&
    mid.x <= room.maxX + SHARE_TOL_M &&
    mid.y >= room.minY - SHARE_TOL_M &&
    mid.y <= room.maxY + SHARE_TOL_M
  return onBoundary || onHBoundary || inside
}

function roomHasAccess(room: RoomAccessNode, doors: Door[], openings: { a: Vec2; b: Vec2 }[]): boolean {
  for (const d of doors) {
    if (openingTouchesRoom(d.opening, room)) return true
  }
  for (const op of openings) {
    if (openingTouchesRoom(op, room)) return true
  }
  return false
}

/** Walls that lie on a shared edge between two room AABB boxes. */
function sharedWallsBetween(
  walls: Wall[],
  a: RoomAccessNode,
  b: RoomAccessNode,
): Wall[] {
  const out: Wall[] = []
  for (const w of walls) {
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }
    const nearA =
      openingTouchesRoom({ a: w.a, b: w.b }, a) ||
      (mid.x >= a.minX - SHARE_TOL_M &&
        mid.x <= a.maxX + SHARE_TOL_M &&
        mid.y >= a.minY - SHARE_TOL_M &&
        mid.y <= a.maxY + SHARE_TOL_M)
    const nearB =
      openingTouchesRoom({ a: w.a, b: w.b }, b) ||
      (mid.x >= b.minX - SHARE_TOL_M &&
        mid.x <= b.maxX + SHARE_TOL_M &&
        mid.y >= b.minY - SHARE_TOL_M &&
        mid.y <= b.maxY + SHARE_TOL_M)
    if (nearA && nearB) out.push(w)
  }
  return out
}

function wallsOnRoomBoundary(walls: Wall[], room: RoomAccessNode): Wall[] {
  return walls.filter((w) => openingTouchesRoom({ a: w.a, b: w.b }, room))
}

function insertOpeningOnWall(wall: Wall, widthM = OPENING_WIDTH_M): { a: Vec2; b: Vec2 } | null {
  const len = wallLen(wall)
  if (len < widthM + 0.2) return null
  const dir = norm(sub(wall.b, wall.a))
  const midT = 0.5
  const half = widthM / 2
  const center = add(wall.a, mul(dir, len * midT))
  const a = roundVec(add(center, mul(dir, -half)))
  const b = roundVec(add(center, mul(dir, half)))
  return { a, b }
}

/**
 * Infer coarse rooms from wall extents when AI did not supply polygons:
 * split the overall AABB at the longest near-vertical or near-horizontal interior wall.
 */
export function inferRoomsFromWalls(walls: Wall[]): RoomAccessNode[] {
  if (walls.length === 0) return []
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const w of walls) {
    minX = Math.min(minX, w.a.x, w.b.x)
    minY = Math.min(minY, w.a.y, w.b.y)
    maxX = Math.max(maxX, w.a.x, w.b.x)
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  if (!Number.isFinite(minX) || maxX - minX < 0.5 || maxY - minY < 0.5) {
    return [{ id: "room-0", minX, minY, maxX, maxY }]
  }

  let best: Wall | null = null
  let bestScore = 0
  for (const w of walls) {
    const len = wallLen(w)
    if (len < 1.2) continue
    const ang = undirectedAngleDiff(wallAngle(w), 0)
    const isH = ang < 0.25
    const isV = undirectedAngleDiff(wallAngle(w), Math.PI / 2) < 0.25
    if (!isH && !isV) continue
    const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 }
    const margin = 0.4
    const interior =
      mid.x > minX + margin && mid.x < maxX - margin && mid.y > minY + margin && mid.y < maxY - margin
    if (!interior) continue
    if (len > bestScore) {
      bestScore = len
      best = w
    }
  }

  if (!best) {
    return [{ id: "room-0", label: "空間", minX, minY, maxX, maxY }]
  }

  const mid = { x: (best.a.x + best.b.x) / 2, y: (best.a.y + best.b.y) / 2 }
  const isV = undirectedAngleDiff(wallAngle(best), Math.PI / 2) < 0.25
  if (isV) {
    return [
      { id: "room-0", label: "空間A", minX, minY, maxX: mid.x, maxY },
      { id: "room-1", label: "空間B", minX: mid.x, minY, maxX, maxY },
    ]
  }
  return [
    { id: "room-0", label: "空間A", minX, minY, maxX, maxY: mid.y },
    { id: "room-1", label: "空間B", minX, minY: mid.y, maxX, maxY },
  ]
}

export function roomsFromPolygons(
  polygons: { id?: string; label?: string; polygon: Vec2[] }[],
): RoomAccessNode[] {
  return polygons.map((r, i) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of r.polygon) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    return {
      id: r.id ?? `room-${i}`,
      label: r.label,
      minX,
      minY,
      maxX,
      maxY,
    }
  })
}

/**
 * Ensure every room has opening access. Mutates a copy of the floorplan.
 * Topology preferred: remove short spurious shared seals before inventing openings.
 */
export function ensureRoomAccess(
  floorplan: Floorplan,
  rooms: RoomAccessNode[],
  extraOpenings: { a: Vec2; b: Vec2 }[] = [],
): ConnectivityResult {
  const notes: string[] = []
  const sealedRoomsFixed: string[] = []
  const removedWallIds: string[] = []
  const addedOpeningIds: string[] = []

  let walls = floorplan.walls.map((w) => ({ ...w }))
  let doors = floorplan.doors.map((d) => ({ ...d, opening: { ...d.opening } }))

  if (rooms.length === 0) {
    return {
      floorplan: { ...floorplan, walls, doors },
      notes,
      sealedRoomsFixed,
      removedWallIds,
      addedOpeningIds,
    }
  }

  for (const room of rooms) {
    if (roomHasAccess(room, doors, extraOpenings)) continue

    sealedRoomsFixed.push(room.id)
    const neighbors = rooms.filter((r) => r.id !== room.id)
    let fixed = false

    // 1) Prefer removing a short spurious wall that seals this room from a neighbor / corridor.
    const boundary = wallsOnRoomBoundary(walls, room)
    const shortSeals = boundary
      .filter((w) => wallLen(w) <= SHORT_SPURIOUS_M && wallLen(w) >= MIN_SEGMENT_LENGTH_M * 0.5)
      .sort((a, b) => wallLen(a) - wallLen(b))

    for (const seal of shortSeals) {
      // Only remove if it also borders another room or is clearly interior.
      const touchesNeighbor = neighbors.some((n) =>
        sharedWallsBetween([seal], room, n).length > 0 || openingTouchesRoom({ a: seal.a, b: seal.b }, n),
      )
      const mid = { x: (seal.a.x + seal.b.x) / 2, y: (seal.a.y + seal.b.y) / 2 }
      const outer =
        Math.abs(mid.x - room.minX) < 0.15 ||
        Math.abs(mid.x - room.maxX) < 0.15 ||
        Math.abs(mid.y - room.minY) < 0.15 ||
        Math.abs(mid.y - room.maxY) < 0.15
      if (!touchesNeighbor && outer && neighbors.length > 0) continue

      walls = walls.filter((w) => w.id !== seal.id)
      removedWallIds.push(seal.id)
      notes.push(
        `連通性：移除可能封死走道／房間的短牆段 ${seal.id}（拓樸優先於保留多餘牆段）。`,
      )
      fixed = true
      break
    }

    if (fixed) continue

    // 2) Add an opening on the longest shared wall with a neighbor.
    let bestWall: Wall | null = null
    let bestLen = 0
    for (const n of neighbors) {
      for (const w of sharedWallsBetween(walls, room, n)) {
        const len = wallLen(w)
        if (len > bestLen) {
          bestLen = len
          bestWall = w
        }
      }
    }
    if (!bestWall) {
      // Fall back to longest boundary wall of this room.
      for (const w of boundary) {
        const len = wallLen(w)
        if (len > bestLen) {
          bestLen = len
          bestWall = w
        }
      }
    }

    if (bestWall) {
      const opening = insertOpeningOnWall(bestWall)
      if (opening) {
        const [oa, ob] = canonicalize(opening.a, opening.b)
        const id = doorStableId("opening", oa, ob, null)
        doors.push({
          id,
          kind: "swing",
          wallId: bestWall.id,
          opening: { a: oa, b: ob },
          confidence: 0.35,
          swing: {
            hinge: roundVec(oa),
            leafLengthM: dist(oa, ob),
            openDirection: "cw",
            arcQuarter: true,
          },
        })
        addedOpeningIds.push(id)
        extraOpenings.push(opening)
        notes.push(
          `連通性：房間「${room.label ?? room.id}」無出入口，已在共用牆 ${bestWall.id} 補開口（請於疊圖確認）。`,
        )
        fixed = true
      }
    }

    if (!fixed) {
      notes.push(
        `連通性：房間「${room.label ?? room.id}」仍可能無出入口，請人工確認。`,
      )
    }
  }

  // Drop doors whose wall was removed.
  const wallIds = new Set(walls.map((w) => w.id))
  doors = doors.filter((d) => wallIds.has(d.wallId))

  const metaNotes = [...(floorplan.meta.notes ?? []), ...notes]
  return {
    floorplan: {
      ...floorplan,
      walls,
      doors,
      meta: {
        ...floorplan.meta,
        notes: dedupe(metaNotes),
      },
    },
    notes,
    sealedRoomsFixed,
    removedWallIds,
    addedOpeningIds,
  }
}

/** Pure helper for tests: build access adjacency via shared openings. */
export function buildRoomAccessGraph(
  rooms: RoomAccessNode[],
  doors: Door[],
): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>()
  for (const r of rooms) graph.set(r.id, new Set())
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]
      const b = rooms[j]
      const linked = doors.some(
        (d) => openingTouchesRoom(d.opening, a) && openingTouchesRoom(d.opening, b),
      )
      if (linked) {
        graph.get(a.id)!.add(b.id)
        graph.get(b.id)!.add(a.id)
      }
    }
  }
  return graph
}

function dedupe(xs: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    if (seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/** Project candidate opening endpoints onto nearest wall; return null if far. */
export function snapOpeningToWalls(
  openingA: Vec2,
  openingB: Vec2,
  walls: Wall[],
  tolM = 0.35,
): { wallId: string; a: Vec2; b: Vec2 } | null {
  if (walls.length === 0) return null
  let best: { wallId: string; a: Vec2; b: Vec2; score: number } | null = null
  for (const w of walls) {
    const pa = projectPoint(openingA, w.a, w.b)
    const pb = projectPoint(openingB, w.a, w.b)
    if (pa.distance > tolM || pb.distance > tolM) continue
    const score = pa.distance + pb.distance
    if (!best || score < best.score) {
      best = { wallId: w.id, a: roundVec(pa.point), b: roundVec(pb.point), score }
    }
  }
  return best ? { wallId: best.wallId, a: best.a, b: best.b } : null
}

export function defaultWallThickness(): number {
  return DEFAULT_WALL_THICKNESS_M
}
