/**
 * Convert Floorplan (metres, bottom-left Y-up) → PlanBlueprint (mm, SVG Y-down).
 * Studio only snaps near-axis walls well; diagonals beyond ~8° are skipped with a note.
 */
import type { Door, Floorplan, Vec2, Window } from "./floorplan.ts"
import type {
  OpeningRect,
  PlanBlueprint,
  PlanRoom,
  SlidingDoor,
  SwingDoor,
  WallKind,
  WallRect,
} from "../plan/types/blueprint.ts"
import { DEFAULT_WALL_THICKNESS_M } from "./units.ts"

const ANGLE_SNAP_DEG = 8
const PAD_MM = 1200

function roundMm(n: number): number {
  return Math.round(n)
}

function toStudioPoint(p: Vec2, maxY_m: number): [number, number] {
  // Flip Y: floorplan Y-up (bottom-left) → studio Y-down
  return [roundMm(p.x * 1000), roundMm((maxY_m - p.y) * 1000)]
}

function maxYOf(fp: Floorplan): number {
  let maxY = 0
  for (const w of fp.walls) {
    maxY = Math.max(maxY, w.a.y, w.b.y)
  }
  for (const d of fp.doors) {
    maxY = Math.max(maxY, d.opening.a.y, d.opening.b.y)
  }
  for (const w of fp.windows) {
    maxY = Math.max(maxY, w.opening.a.y, w.opening.b.y)
  }
  if (maxY <= 0) {
    maxY = fp.meta.imageHeightPx * fp.meta.metersPerPixel
  }
  return maxY
}

function undirectedAngleDeg(a: Vec2, b: Vec2): number {
  const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  let d = Math.abs(ang) % 180
  if (d > 90) d = 180 - d
  return d // 0 = horizontal, 90 = vertical
}

function snapAxis(a: Vec2, b: Vec2): { a: Vec2; b: Vec2; axis: "h" | "v" } | null {
  const d = undirectedAngleDeg(a, b)
  if (d <= ANGLE_SNAP_DEG) {
    // near horizontal in floorplan (Y-up)
    const y = (a.y + b.y) / 2
    return { a: { x: a.x, y }, b: { x: b.x, y }, axis: "h" }
  }
  if (d >= 90 - ANGLE_SNAP_DEG) {
    const x = (a.x + b.x) / 2
    return { a: { x, y: a.y }, b: { x, y: b.y }, axis: "v" }
  }
  return null
}

function thicknessRect(
  a: Vec2,
  b: Vec2,
  thicknessM: number,
  maxY: number,
  kind: WallKind,
): WallRect | null {
  const snapped = snapAxis(a, b)
  if (!snapped) return null
  const t = Math.max(thicknessM, DEFAULT_WALL_THICKNESS_M) * 1000
  const half = t / 2
  const p0 = toStudioPoint(snapped.a, maxY)
  const p1 = toStudioPoint(snapped.b, maxY)
  if (snapped.axis === "h") {
    // floorplan H → studio H (Y flipped but still horizontal)
    const y = (p0[1] + p1[1]) / 2
    const x0 = Math.min(p0[0], p1[0])
    const x1 = Math.max(p0[0], p1[0])
    return [roundMm(x0), roundMm(y - half), roundMm(x1), roundMm(y + half), kind]
  }
  const x = (p0[0] + p1[0]) / 2
  const y0 = Math.min(p0[1], p1[1])
  const y1 = Math.max(p0[1], p1[1])
  return [roundMm(x - half), roundMm(y0), roundMm(x + half), roundMm(y1), kind]
}

function openingRect(a: Vec2, b: Vec2, thicknessM: number, maxY: number): OpeningRect | null {
  const snapped = snapAxis(a, b)
  if (!snapped) return null
  const t = Math.max(thicknessM, DEFAULT_WALL_THICKNESS_M) * 1000
  const half = t / 2
  const p0 = toStudioPoint(snapped.a, maxY)
  const p1 = toStudioPoint(snapped.b, maxY)
  if (snapped.axis === "h") {
    const y = (p0[1] + p1[1]) / 2
    return [
      roundMm(Math.min(p0[0], p1[0])),
      roundMm(y - half),
      roundMm(Math.max(p0[0], p1[0])),
      roundMm(y + half),
    ]
  }
  const x = (p0[0] + p1[0]) / 2
  return [
    roundMm(x - half),
    roundMm(Math.min(p0[1], p1[1])),
    roundMm(x + half),
    roundMm(Math.max(p0[1], p1[1])),
  ]
}

function wallThickness(fp: Floorplan, wallId: string): number {
  const w = fp.walls.find((x) => x.id === wallId)
  return w?.thicknessM ?? DEFAULT_WALL_THICKNESS_M
}

function unit(dx: number, dy: number): [number, number] {
  const L = Math.hypot(dx, dy) || 1
  return [dx / L, dy / L]
}

function convertSwing(door: Door, fp: Floorplan, maxY: number, index: number): SwingDoor | null {
  const thick = wallThickness(fp, door.wallId)
  const rect = openingRect(door.opening.a, door.opening.b, thick, maxY)
  if (!rect) return null
  const hingeSrc = door.swing?.hinge ?? door.opening.a
  const hinge = toStudioPoint(hingeSrc, maxY)
  const other =
    Math.hypot(door.opening.a.x - hingeSrc.x, door.opening.a.y - hingeSrc.y) < 1e-6
      ? door.opening.b
      : door.opening.a
  const otherStudio = toStudioPoint(other, maxY)
  // Closed direction: from hinge along opening (studio coords)
  const c = unit(otherStudio[0] - hinge[0], otherStudio[1] - hinge[1])
  // Open direction: rotate closed by ±90°. Floorplan cw/ccw is Y-up; after Y-flip swap sense.
  const od = door.swing?.openDirection ?? "cw"
  const sign = od === "cw" ? 1 : -1 // after Y-flip: cw (Y-up) → rotate c by +90° in studio
  const o: [number, number] = [-sign * c[1], sign * c[0]]
  const len = roundMm((door.swing?.leafLengthM ?? Math.hypot(other.x - hingeSrc.x, other.y - hingeSrc.y)) * 1000)
  return {
    name: `門 ${index + 1}`,
    rect,
    h: [hinge[0], hinge[1]],
    c: [Math.round(c[0]), Math.round(c[1])],
    o: [Math.round(o[0]), Math.round(o[1])],
    len: Math.max(600, len),
  }
}

function convertSliding(door: Door, fp: Floorplan, maxY: number): SlidingDoor | null {
  const thick = wallThickness(fp, door.wallId)
  const rect = openingRect(door.opening.a, door.opening.b, thick, maxY)
  if (!rect) return null
  const v = rect[2] - rect[0] < rect[3] - rect[1]
  return { rect, v }
}

function convertWindow(win: Window, fp: Floorplan, maxY: number): OpeningRect | null {
  return openingRect(win.opening.a, win.opening.b, wallThickness(fp, win.wallId), maxY)
}

function expandBounds(rects: Array<[number, number, number, number]>, pad: number) {
  if (!rects.length) {
    return { x: -pad, y: -pad, w: 8000, h: 6000 }
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x0, y0, x1, y1] of rects) {
    minX = Math.min(minX, x0, x1)
    minY = Math.min(minY, y0, y1)
    maxX = Math.max(maxX, x0, x1)
    maxY = Math.max(maxY, y0, y1)
  }
  return {
    x: roundMm(minX - pad),
    y: roundMm(minY - pad),
    w: roundMm(maxX - minX + pad * 2),
    h: roundMm(maxY - minY + pad * 2),
  }
}

function roomFromWalls(walls: WallRect[]): PlanRoom {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const [x0, y0, x1, y1] of walls) {
    minX = Math.min(minX, x0, x1)
    minY = Math.min(minY, y0, y1)
    maxX = Math.max(maxX, x0, x1)
    maxY = Math.max(maxY, y0, y1)
  }
  const inset = 60
  const x0 = minX + inset
  const y0 = minY + inset
  const x1 = maxX - inset
  const y1 = maxY - inset
  const poly: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
  return {
    id: "main",
    name: "室內",
    poly,
    mat: "wood",
    at: [roundMm((x0 + x1) / 2), roundMm((y0 + y1) / 2)],
  }
}

export function floorplanToBlueprint(floorplan: Floorplan): PlanBlueprint {
  const notes = [...(floorplan.meta.notes ?? [])]
  const maxY = maxYOf(floorplan)
  const walls: WallRect[] = []
  let skippedDiagonal = 0

  for (const w of floorplan.walls) {
    const kind: WallKind = "e"
    const rect = thicknessRect(w.a, w.b, w.thicknessM, maxY, kind)
    if (!rect) {
      skippedDiagonal++
      continue
    }
    walls.push(rect)
  }
  if (skippedDiagonal > 0) {
    notes.push(`略過 ${skippedDiagonal} 段斜牆（與水平／垂直夾角超過約 ${ANGLE_SNAP_DEG}°；工作室目前以軸對齊牆為主）。`)
  }

  const swingDoors: SwingDoor[] = []
  const slidingDoors: SlidingDoor[] = []
  let doorI = 0
  for (const d of floorplan.doors) {
    if (d.kind === "sliding") {
      const s = convertSliding(d, floorplan, maxY)
      if (s) slidingDoors.push(s)
      else notes.push("略過一道斜向拉門。")
    } else {
      const s = convertSwing(d, floorplan, maxY, doorI++)
      if (s) swingDoors.push(s)
      else notes.push("略過一道斜向平開門。")
    }
  }
  if (swingDoors.length === 1) swingDoors[0].entry = true

  const windowOpenings: OpeningRect[] = []
  for (const w of floorplan.windows) {
    const r = convertWindow(w, floorplan, maxY)
    if (r) windowOpenings.push(r)
    else notes.push("略過一道斜向窗。")
  }

  const planRooms: PlanRoom[] =
    walls.length > 0
      ? [roomFromWalls(walls)]
      : [
          {
            id: "main",
            name: "室內",
            poly: [
              [0, 0],
              [6000, 0],
              [6000, 4000],
              [0, 4000],
            ],
            mat: "wood",
            at: [3000, 2000],
          },
        ]
  notes.push("房間為牆體外框內縮的單區「室內」；細分房名／OCR 標註為後續 Phase。")

  const allRects: Array<[number, number, number, number]> = [
    ...walls.map(([x0, y0, x1, y1]) => [x0, y0, x1, y1] as [number, number, number, number]),
    ...windowOpenings,
    ...swingDoors.map((d) => d.rect),
    ...slidingDoors.map((d) => d.rect),
  ]
  const bounds = expandBounds(allRects, PAD_MM)
  const origin = {
    ox: roundMm(bounds.x + bounds.w / 2),
    oy: roundMm(bounds.y + bounds.h / 2),
  }

  const nameBase = floorplan.meta.sourceName?.replace(/\.[^.]+$/, "") || "匯入平面圖"
  return {
    id: `import-${Date.now().toString(36)}`,
    name: nameBase,
    source: "import",
    walls,
    windowOpenings,
    swingDoors,
    slidingDoors,
    planRooms,
    bounds,
    origin,
    lintelOpenings: [],
    notes,
  }
}

/** walls used only for typing exhaustiveness in older callers */
