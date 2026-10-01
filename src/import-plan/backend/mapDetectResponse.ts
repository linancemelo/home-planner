/**
 * Map DetectApiResponse → Floorplan + excavations for overlay / floorplanToBlueprint.
 */
import type { DetectApiResponse } from "./detectClient.ts"
import type { Excavation, Floorplan, FloorplanRoom } from "../floorplan.ts"
import { parseFloorplan } from "../schema.ts"

export type BackendDetectMapped = {
  floorplan: Floorplan
  excavations: Excavation[]
  notes: string[]
}

export function mapDetectResponseToFloorplan(raw: DetectApiResponse): BackendDetectMapped {
  const rooms: FloorplanRoom[] = (raw.rooms ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    vertices: r.vertices.map((v) => ({ x: v.x, y: v.y })),
    confidence: r.confidence,
  }))

  const notes = [
    ...(raw.notes ?? []),
    ...(raw.meta.notes ?? []),
    ...(raw.mock ? ["來源：本機 Detect API（mock，尚未 YOLO）。"] : ["來源：本機 Detect API。"]),
  ]
  // dedupe
  const seen = new Set<string>()
  const uniqNotes: string[] = []
  for (const n of notes) {
    if (seen.has(n)) continue
    seen.add(n)
    uniqNotes.push(n)
  }

  const candidate = {
    version: 1 as const,
    meta: {
      sourceName: raw.meta.sourceName,
      imageWidthPx: raw.meta.imageWidthPx,
      imageHeightPx: raw.meta.imageHeightPx,
      metersPerPixel: raw.meta.metersPerPixel,
      scaleTrusted: false as const,
      coordinateOrigin: raw.meta.coordinateOrigin,
      ceilingHeightM: raw.meta.ceilingHeightM,
      ceilingHeightAssumed: true as const,
      detectionConfidence: raw.confidence ?? raw.meta.detectionConfidence,
      notes: uniqNotes,
    },
    walls: raw.walls,
    doors: raw.doors,
    windows: raw.windows,
    rooms,
  }

  const floorplan = parseFloorplan(candidate)

  const excavations: Excavation[] = []
  for (const d of floorplan.doors) {
    excavations.push({ a: d.opening.a, b: d.opening.b, kind: "door" })
  }
  for (const w of floorplan.windows) {
    excavations.push({ a: w.opening.a, b: w.opening.b, kind: "window" })
  }

  return { floorplan, excavations, notes: uniqNotes }
}
