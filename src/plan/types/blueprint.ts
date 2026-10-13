/** Studio geometry blueprint (mm). Data-driven replacement for module-level apartment constants. */

export type WallKind = "b" | "e" | "n" | "low"

/** Axis-aligned wall rectangle: [x0, y0, x1, y1, kind] in mm. */
export type WallRect = [number, number, number, number, WallKind]

/** Axis-aligned opening rectangle: [x0, y0, x1, y1] in mm. */
export type OpeningRect = [number, number, number, number]

export type SwingDoor = {
  name: string
  rect: OpeningRect
  h: [number, number]
  c: [number, number]
  o: [number, number]
  len: number
  entry?: boolean
}

export type SlidingDoor = {
  rect: OpeningRect
  v: boolean
}

export type PlanRoom = {
  id: string
  name: string
  poly: [number, number][]
  mat: string
  at?: [number, number]
  counted?: boolean
}

export type PlanBounds = { x: number; y: number; w: number; h: number }

export type PlanOrigin = { ox: number; oy: number }

/** Optional lintel openings above doors/windows: [rect, headHeightM]. */
export type LintelOpening = [OpeningRect, number]

export type PlanBlueprint = {
  id: string
  name: string
  source: "default" | "import"
  walls: WallRect[]
  windowOpenings: OpeningRect[]
  swingDoors: SwingDoor[]
  slidingDoors: SlidingDoor[]
  planRooms: PlanRoom[]
  bounds: PlanBounds
  origin: PlanOrigin
  lintelOpenings?: LintelOpening[]
  notes?: string[]
}

export const BLUEPRINT_STORAGE_KEY = "home-planner-blueprint-v1" as const
