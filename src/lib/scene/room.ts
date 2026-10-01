import type { Floorplan, Vec2 } from "../../types/floorplan.ts"
import { dist } from "../geometry.ts"

/** 平面公尺 → Three.js XZ。Y 向上。左下原點的平面 +y 對到 -Z。 */
export function planToWorld(
  p: Vec2,
  origin: Floorplan["meta"]["coordinateOrigin"],
): { x: number; z: number } {
  if (origin === "top-left") return { x: p.x, z: p.y }
  return { x: p.x, z: -p.y }
}

/** 局部 +X 轉到世界 (dx, dz) 時，物體的 rotation.y。 */
export function yawForDirection(dx: number, dz: number): number {
  const len = Math.hypot(dx, dz)
  if (len < 1e-8) return 0
  return Math.atan2(-dz / len, dx / len)
}

/** rotation.y 之後，局部 +X 在世界上的方向。 */
export function directionFromYaw(yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) }
}

export function shortestAngle(delta: number): number {
  let d = delta
  while (d > Math.PI) d -= Math.PI * 2
  while (d < -Math.PI) d += Math.PI * 2
  return d
}

const DOOR_HEIGHT = 2.1
const WINDOW_HEAD = 2.1
const PLAYER_RADIUS = 0.2

export type BoxSolid = {
  id: string
  center: { x: number; y: number; z: number }
  size: { x: number; y: number; z: number }
  yaw: number
  role: "wall" | "sill" | "header"
}

export type GlassPane = {
  id: string
  center: { x: number; y: number; z: number }
  size: { x: number; y: number; z: number }
  yaw: number
}

export type SwingDoor = {
  id: string
  hingeX: number
  hingeZ: number
  yawClosed: number
  openYaw: number
  length: number
  height: number
  thickness: number
  focusX: number
  focusZ: number
}

export type SlidingLeaf = {
  x: number
  z: number
  yaw: number
  length: number
  thickness: number
  slideX: number
  slideZ: number
}

export type SlidingDoor = {
  id: string
  leaves: SlidingLeaf[]
  height: number
  focusX: number
  focusZ: number
}

export type CollisionSeg = {
  ax: number
  az: number
  bx: number
  bz: number
  radius: number
}

export type RoomModel = {
  ceiling: number
  solids: BoxSolid[]
  glass: GlassPane[]
  swings: SwingDoor[]
  sliders: SlidingDoor[]
  collision: CollisionSeg[]
  spawn: { x: number; z: number; eye: number; yaw: number }
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
}

type Cut = { t0: number; t1: number }

export function buildRoom(plan: Floorplan): RoomModel {
  const origin = plan.meta.coordinateOrigin
  const ceiling = plan.meta.ceilingHeightM
  const solids: BoxSolid[] = []
  const glass: GlassPane[] = []
  const collision: CollisionSeg[] = []
  const swings: SwingDoor[] = []
  const sliders: SlidingDoor[] = []

  const thicknessById = new Map(plan.walls.map((wall) => [wall.id, wall.thicknessM]))
  const heightById = new Map(plan.walls.map((wall) => [wall.id, wall.heightM ?? ceiling]))

  const openings = [
    ...plan.doors.map((door) => ({
      id: door.id,
      kind: "door" as const,
      a: door.opening.a,
      b: door.opening.b,
      wallId: door.wallId,
    })),
    ...plan.windows.map((win) => ({
      id: win.id,
      kind: "window" as const,
      a: win.opening.a,
      b: win.opening.b,
      wallId: win.wallId,
    })),
  ]

  for (const wall of plan.walls) {
    const length = dist(wall.a, wall.b)
    if (length < 0.02) continue
    const cuts: Cut[] = []
    for (const opening of openings) {
      const span = overlapOnSegment(wall.a, wall.b, opening.a, opening.b, Math.max(wall.thicknessM * 1.4, 0.18))
      if (span && span.t1 - span.t0 > 0.05) cuts.push(span)
    }
    const pieces = complement(length, mergeCuts(cuts))
    const top = wall.heightM ?? ceiling
    pieces.forEach((piece, index) => {
      const a = pointAt(wall.a, wall.b, piece.t0 / length)
      const b = pointAt(wall.a, wall.b, piece.t1 / length)
      pushBox(solids, collision, `${wall.id}:${index}`, a, b, wall.thicknessM, 0, top, origin, "wall")
    })
  }

  for (const win of plan.windows) {
    const length = dist(win.opening.a, win.opening.b)
    if (length < 0.2) continue
    const thickness = thicknessById.get(win.wallId) ?? 0.12
    const top = heightById.get(win.wallId) ?? ceiling
    const sill = Math.max(0, Math.min(win.sillHeightM ?? 0.9, top - 0.35))
    let head = Math.min(WINDOW_HEAD, top - 0.06)
    if (head < sill + 0.3) head = Math.min(top - 0.04, sill + 0.3)
    if (sill > 0.04) {
      pushBox(solids, collision, `${win.id}:sill`, win.opening.a, win.opening.b, thickness, 0, sill, origin, "sill")
    } else {
      pushCollision(collision, win.opening.a, win.opening.b, thickness, origin)
    }
    if (top - head > 0.04) {
      pushBox(solids, null, `${win.id}:head`, win.opening.a, win.opening.b, thickness, head, top, origin, "header")
    }
    const midY = (sill + head) / 2
    const pane = oriented(win.opening.a, win.opening.b, origin)
    if (pane && head - sill > 0.15) {
      glass.push({
        id: win.id,
        center: { x: pane.mx, y: midY, z: pane.mz },
        size: { x: pane.length, y: head - sill, z: 0.02 },
        yaw: pane.yaw,
      })
    }
  }

  const doorHeight = Math.min(DOOR_HEIGHT, Math.max(1.4, ceiling - 0.12))

  for (const door of plan.doors) {
    const length = dist(door.opening.a, door.opening.b)
    if (length < 0.25) continue
    const thickness = thicknessById.get(door.wallId) ?? 0.12
    const top = heightById.get(door.wallId) ?? ceiling
    const leafH = Math.min(doorHeight, top - 0.02)
    if (top - leafH > 0.04) {
      pushBox(solids, null, `${door.id}:head`, door.opening.a, door.opening.b, thickness, leafH, top, origin, "header")
    }
    const aw = planToWorld(door.opening.a, origin)
    const bw = planToWorld(door.opening.b, origin)
    const focusX = (aw.x + bw.x) / 2
    const focusZ = (aw.z + bw.z) / 2

    if (door.kind === "swing" && door.swing) {
      const hingeIsA = dist(door.swing.hinge, door.opening.a) <= dist(door.swing.hinge, door.opening.b)
      const hingePlan = hingeIsA ? door.opening.a : door.opening.b
      const otherPlan = hingeIsA ? door.opening.b : door.opening.a
      const nearEnd = dist(door.swing.hinge, hingePlan) < 0.25
      const hinge = nearEnd ? hingePlan : door.swing.hinge
      const leaf = dist(hinge, otherPlan)
      if (leaf < 0.25) continue
      const hw = planToWorld(hinge, origin)
      const ow = planToWorld(otherPlan, origin)
      const yawClosed = yawForDirection(ow.x - hw.x, ow.z - hw.z)
      const closed = { x: otherPlan.x - hinge.x, y: otherPlan.y - hinge.y }
      const turned = door.swing.openDirection === "ccw"
        ? { x: -closed.y, y: closed.x }
        : { x: closed.y, y: -closed.x }
      const tip = planToWorld({ x: hinge.x + turned.x, y: hinge.y + turned.y }, origin)
      const yawOpen = yawForDirection(tip.x - hw.x, tip.z - hw.z)
      swings.push({
        id: door.id,
        hingeX: hw.x,
        hingeZ: hw.z,
        yawClosed,
        openYaw: shortestAngle(yawOpen - yawClosed),
        length: leaf,
        height: leafH,
        thickness: Math.min(0.045, thickness * 0.55),
        focusX,
        focusZ,
      })
    } else if (door.kind === "sliding") {
      const pane = oriented(door.opening.a, door.opening.b, origin)
      if (!pane) continue
      const ux = Math.cos(pane.yaw)
      const uz = -Math.sin(pane.yaw)
      const nx = -uz
      const nz = ux
      const offset = Math.min(0.03, thickness * 0.3)
      const leafLen = pane.length * 0.56
      const slide = pane.length * 0.42
      const centers = [0.25, 0.75]
      const leaves: SlidingLeaf[] = centers.map((t, index) => {
        const sign = index === 0 ? -1 : 1
        const along = (t - 0.5) * pane.length
        const side = index === 0 ? 1 : -1
        return {
          x: pane.mx + ux * along + nx * offset * side,
          z: pane.mz + uz * along + nz * offset * side,
          yaw: pane.yaw,
          length: leafLen,
          thickness: Math.min(0.04, thickness * 0.45),
          slideX: ux * slide * sign,
          slideZ: uz * slide * sign,
        }
      })
      sliders.push({ id: door.id, leaves, height: leafH, focusX, focusZ })
    }
  }

  const bounds = boundsOf(plan, origin)
  const eye = Math.min(1.6, Math.max(1.2, ceiling - 0.35))
  const closedDoors = doorBlockers({ swings, sliders } as RoomModel, {})
  const spawn = findSpawn(bounds, collision, closedDoors, eye, swings, sliders)

  return { ceiling, solids, glass, swings, sliders, collision, spawn, bounds }
}

export function doorBlockers(model: Pick<RoomModel, "swings" | "sliders">, open: Record<string, number>): CollisionSeg[] {
  const segs: CollisionSeg[] = []
  for (const door of model.swings) {
    const amount = clamp01(open[door.id] ?? 0)
    const yaw = door.yawClosed + door.openYaw * amount
    const dir = directionFromYaw(yaw)
    segs.push({
      ax: door.hingeX,
      az: door.hingeZ,
      bx: door.hingeX + dir.x * door.length,
      bz: door.hingeZ + dir.z * door.length,
      radius: door.thickness / 2,
    })
  }
  for (const door of model.sliders) {
    const amount = clamp01(open[door.id] ?? 0)
    for (const leaf of door.leaves) {
      const dir = directionFromYaw(leaf.yaw)
      const cx = leaf.x + leaf.slideX * amount
      const cz = leaf.z + leaf.slideZ * amount
      const hx = (dir.x * leaf.length) / 2
      const hz = (dir.z * leaf.length) / 2
      segs.push({
        ax: cx - hx,
        az: cz - hz,
        bx: cx + hx,
        bz: cz + hz,
        radius: leaf.thickness / 2,
      })
    }
  }
  return segs
}

export function isBlocked(x: number, z: number, radius: number, segs: CollisionSeg[]): boolean {
  for (const seg of segs) {
    if (distToSegment(x, z, seg.ax, seg.az, seg.bx, seg.bz) < radius + seg.radius) return true
  }
  return false
}

export { PLAYER_RADIUS }

function findSpawn(
  bounds: RoomModel["bounds"],
  collision: CollisionSeg[],
  doors: CollisionSeg[],
  eye: number,
  swings: SwingDoor[],
  sliders: SlidingDoor[],
): RoomModel["spawn"] {
  const cx = (bounds.minX + bounds.maxX) / 2
  const cz = (bounds.minZ + bounds.maxZ) / 2
  const segs = [...collision, ...doors]
  const focuses = [...swings, ...sliders]
  const candidates = [{ x: cx, z: cz }]
  for (let ring = 1; ring <= 10; ring++) {
    const radius = ring * 0.4
    for (let step = 0; step < 18; step++) {
      const ang = (step / 18) * Math.PI * 2
      candidates.push({ x: cx + Math.cos(ang) * radius, z: cz + Math.sin(ang) * radius })
    }
  }
  let best = { x: cx, z: cz }
  let bestGap = -1
  let fallback = { x: cx, z: cz }
  let haveFallback = false
  const inset = 0.4
  for (const candidate of candidates) {
    if (isBlocked(candidate.x, candidate.z, PLAYER_RADIUS, segs)) continue
    if (!haveFallback) {
      fallback = candidate
      haveFallback = true
    }
    const inside =
      candidate.x > bounds.minX + inset &&
      candidate.x < bounds.maxX - inset &&
      candidate.z > bounds.minZ + inset &&
      candidate.z < bounds.maxZ - inset
    if (!inside) continue
    let gap = Infinity
    for (const door of focuses) {
      gap = Math.min(gap, Math.hypot(door.focusX - candidate.x, door.focusZ - candidate.z))
    }
    if (focuses.length === 0) gap = 10
    if (gap > bestGap) {
      bestGap = gap
      best = candidate
      if (gap >= 1.35) break
    }
  }
  if (bestGap < 0 && haveFallback) best = fallback
  const focus = focuses.reduce<(typeof focuses)[number] | null>((nearest, door) => {
    if (!nearest) return door
    const here = Math.hypot(door.focusX - best.x, door.focusZ - best.z)
    const prev = Math.hypot(nearest.focusX - best.x, nearest.focusZ - best.z)
    return here < prev ? door : nearest
  }, null)
  let yaw = Math.PI / 2
  if (focus) {
    const dx = focus.focusX - best.x
    const dz = focus.focusZ - best.z
    if (Math.hypot(dx, dz) > 0.3) yaw = Math.atan2(-dx, -dz)
  }
  return { x: best.x, z: best.z, eye, yaw }
}

function boundsOf(plan: Floorplan, origin: Floorplan["meta"]["coordinateOrigin"]): RoomModel["bounds"] {
  const pts: { x: number; z: number }[] = []
  for (const wall of plan.walls) {
    pts.push(planToWorld(wall.a, origin), planToWorld(wall.b, origin))
  }
  for (const door of plan.doors) {
    pts.push(planToWorld(door.opening.a, origin), planToWorld(door.opening.b, origin))
  }
  for (const win of plan.windows) {
    pts.push(planToWorld(win.opening.a, origin), planToWorld(win.opening.b, origin))
  }
  if (pts.length === 0) return { minX: -1, maxX: 5, minZ: -5, maxZ: 1 }
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  if (maxX - minX < 0.5) {
    minX -= 1
    maxX += 1
  }
  if (maxZ - minZ < 0.5) {
    minZ -= 1
    maxZ += 1
  }
  return { minX, maxX, minZ, maxZ }
}

function pushBox(
  solids: BoxSolid[],
  collision: CollisionSeg[] | null,
  id: string,
  a: Vec2,
  b: Vec2,
  thickness: number,
  y0: number,
  y1: number,
  origin: Floorplan["meta"]["coordinateOrigin"],
  role: BoxSolid["role"],
) {
  const pane = oriented(a, b, origin)
  if (!pane || pane.length < 0.02 || y1 - y0 < 0.02) return
  solids.push({
    id,
    center: { x: pane.mx, y: (y0 + y1) / 2, z: pane.mz },
    size: { x: pane.length, y: y1 - y0, z: thickness },
    yaw: pane.yaw,
    role,
  })
  if (collision && y0 < 0.4) pushCollision(collision, a, b, thickness, origin)
}

function pushCollision(
  collision: CollisionSeg[],
  a: Vec2,
  b: Vec2,
  thickness: number,
  origin: Floorplan["meta"]["coordinateOrigin"],
) {
  const aw = planToWorld(a, origin)
  const bw = planToWorld(b, origin)
  collision.push({ ax: aw.x, az: aw.z, bx: bw.x, bz: bw.z, radius: thickness / 2 })
}

function oriented(a: Vec2, b: Vec2, origin: Floorplan["meta"]["coordinateOrigin"]) {
  const aw = planToWorld(a, origin)
  const bw = planToWorld(b, origin)
  const dx = bw.x - aw.x
  const dz = bw.z - aw.z
  const length = Math.hypot(dx, dz)
  if (length < 1e-6) return null
  return {
    length,
    mx: (aw.x + bw.x) / 2,
    mz: (aw.z + bw.z) / 2,
    yaw: yawForDirection(dx, dz),
  }
}

function overlapOnSegment(a: Vec2, b: Vec2, p: Vec2, q: Vec2, tolerance: number): Cut | null {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const l2 = abx * abx + aby * aby
  if (l2 < 1e-8) return null
  const length = Math.sqrt(l2)
  const proj = (point: Vec2) => {
    const t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / l2
    const cx = a.x + abx * t
    const cy = a.y + aby * t
    return { t: t * length, distance: Math.hypot(point.x - cx, point.y - cy) }
  }
  const pp = proj(p)
  const qq = proj(q)
  if (pp.distance > tolerance || qq.distance > tolerance) return null
  const t0 = Math.max(0, Math.min(pp.t, qq.t))
  const t1 = Math.min(length, Math.max(pp.t, qq.t))
  if (t1 - t0 < 0.02) return null
  return { t0, t1 }
}

function mergeCuts(cuts: Cut[]): Cut[] {
  const sorted = [...cuts].sort((a, b) => a.t0 - b.t0)
  const out: Cut[] = []
  for (const cut of sorted) {
    const last = out[out.length - 1]
    if (last && cut.t0 <= last.t1 + 0.02) last.t1 = Math.max(last.t1, cut.t1)
    else out.push({ ...cut })
  }
  return out
}

function complement(length: number, cuts: Cut[]): Cut[] {
  const pieces: Cut[] = []
  let cursor = 0
  for (const cut of cuts) {
    if (cut.t0 - cursor > 0.02) pieces.push({ t0: cursor, t1: cut.t0 })
    cursor = Math.max(cursor, cut.t1)
  }
  if (length - cursor > 0.02) pieces.push({ t0: cursor, t1: length })
  return pieces
}

function pointAt(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax
  const abz = bz - az
  const l2 = abx * abx + abz * abz
  if (l2 < 1e-10) return Math.hypot(px - ax, pz - az)
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (pz - az) * abz) / l2))
  return Math.hypot(px - (ax + abx * t), pz - (az + abz * t))
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}
