/**
 * Merge heuristic PipelineResult with an optional AiFloorplanProposal,
 * then run the connectivity / topology pass.
 *
 * AI never wins over hard rules: furniture wallHints are dropped;
 * spurious corridor seals may be removed; sealed rooms get openings + notes.
 */
import type { Door, Excavation, Floorplan, Vec2, Window } from "../floorplan.ts"
import type { PipelineResult } from "../detect/pipeline.ts"
import { canonicalize, dist, roundVec } from "../geometry.ts"
import { doorStableId, windowStableId } from "../ids.ts"
import { parseFloorplan } from "../schema.ts"
import { DEFAULT_SILL_HEIGHT_M } from "../units.ts"
import type { AiFloorplanProposal } from "./proposal.ts"
import { assertNotFloorplanJson } from "./proposal.ts"
import type { AssembleUiMode } from "./provider.ts"
import {
  ensureRoomAccess,
  inferRoomsFromWalls,
  roomsFromPolygons,
  snapOpeningToWalls,
  type RoomAccessNode,
} from "./connectivity.ts"

export type AssembleResult = PipelineResult & {
  mode: AssembleUiMode
  assembleNotes: string[]
  proposalUsed: boolean
}

function toMeters(
  pt: Vec2,
  space: AiFloorplanProposal["coordinateSpace"],
  imageWidthPx: number,
  imageHeightPx: number,
  metersPerPixel: number,
): Vec2 {
  if (space === "meters-bottom-left") return pt
  if (space === "pixels-top-left") {
    return { x: pt.x * metersPerPixel, y: (imageHeightPx - pt.y) * metersPerPixel }
  }
  const px = { x: pt.x * imageWidthPx, y: pt.y * imageHeightPx }
  return { x: px.x * metersPerPixel, y: (imageHeightPx - px.y) * metersPerPixel }
}

function mapProposalPoint(
  pt: Vec2,
  proposal: AiFloorplanProposal,
  fp: Floorplan,
): Vec2 {
  return toMeters(
    pt,
    proposal.coordinateSpace,
    fp.meta.imageWidthPx,
    fp.meta.imageHeightPx,
    fp.meta.metersPerPixel,
  )
}

function openingsNear(op: { a: Vec2; b: Vec2 }, a: Vec2, b: Vec2): boolean {
  const mid1 = { x: (op.a.x + op.b.x) / 2, y: (op.a.y + op.b.y) / 2 }
  const mid2 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  return dist(mid1, mid2) < 0.45
}

function midToward(from: Vec2, to: Vec2, t: number): Vec2 {
  return roundVec({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
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

function mergeAiOpenings(
  floorplan: Floorplan,
  proposal: AiFloorplanProposal,
  notes: string[],
): { floorplan: Floorplan; excavations: Excavation[] } {
  const walls = floorplan.walls.slice()
  const doors = floorplan.doors.slice()
  const windows = floorplan.windows.slice()
  const excavations: Excavation[] = [
    ...doors.map((d) => ({ a: d.opening.a, b: d.opening.b, kind: "door" as const })),
    ...windows.map((w) => ({ a: w.opening.a, b: w.opening.b, kind: "window" as const })),
  ]

  const furnitureHints = (proposal.wallHints ?? []).filter((h) => h.role === "furniture")
  if (furnitureHints.length > 0) {
    notes.push(`AI：略過 ${furnitureHints.length} 段家具牆提示（家具≠結構）。`)
  }
  const structureHints = (proposal.wallHints ?? []).filter((h) => h.role === "structure")
  if (structureHints.length > 0) {
    notes.push(`AI：結構牆提示 ${structureHints.length} 段（不直接新增牆段；拓樸優先）。`)
  }

  for (const cand of proposal.doorCandidates ?? []) {
    const a = mapProposalPoint(cand.openingA, proposal, floorplan)
    const b = mapProposalPoint(cand.openingB, proposal, floorplan)
    if (dist(a, b) < 0.4) continue
    if (doors.some((d) => openingsNear(d.opening, a, b))) continue
    const snapped = snapOpeningToWalls(a, b, walls)
    if (!snapped) {
      notes.push("AI：門候選無法貼齊既有牆，已略過。")
      continue
    }
    const [oa, ob] = canonicalize(snapped.a, snapped.b)
    const kind = cand.kind === "sliding" ? "sliding" : "swing"
    const id = doorStableId(kind, oa, ob, kind === "swing" ? oa : null)
    if (doors.some((d) => d.id === id)) continue
    const door: Door = {
      id,
      kind,
      wallId: snapped.wallId,
      opening: { a: oa, b: ob },
      confidence: cand.confidence ?? 0.55,
    }
    if (kind === "swing") {
      door.swing = {
        hinge: roundVec(oa),
        leafLengthM: dist(oa, ob),
        openDirection: "cw",
        arcQuarter: true,
      }
    } else {
      door.sliding = {
        leafA: { a: oa, b: midToward(oa, ob, 0.45) },
        leafB: { a: midToward(ob, oa, 0.45), b: ob },
      }
    }
    doors.push(door)
    excavations.push({ a: oa, b: ob, kind: "door" })
    notes.push(`AI：合併門候選 → ${id}`)
  }

  for (const cand of proposal.windowCandidates ?? []) {
    const a = mapProposalPoint(cand.openingA, proposal, floorplan)
    const b = mapProposalPoint(cand.openingB, proposal, floorplan)
    if (dist(a, b) < 0.35) continue
    if (windows.some((w) => openingsNear(w.opening, a, b))) continue
    const snapped = snapOpeningToWalls(a, b, walls)
    if (!snapped) {
      notes.push("AI：窗候選無法貼齊既有牆，已略過。")
      continue
    }
    const [oa, ob] = canonicalize(snapped.a, snapped.b)
    const id = windowStableId(oa, ob)
    if (windows.some((w) => w.id === id)) continue
    const win: Window = {
      id,
      wallId: snapped.wallId,
      opening: { a: oa, b: ob },
      confidence: cand.confidence ?? 0.5,
      sillHeightM: DEFAULT_SILL_HEIGHT_M,
      sillHeightAssumed: true,
    }
    windows.push(win)
    excavations.push({ a: oa, b: ob, kind: "window" })
    notes.push(`AI：合併窗候選 → ${id}`)
  }

  for (const label of proposal.ocrLabels ?? []) {
    const at = mapProposalPoint(label.at, proposal, floorplan)
    notes.push(`OCR：「${label.text}」@(${at.x.toFixed(2)}, ${at.y.toFixed(2)})`)
  }
  for (const room of proposal.rooms ?? []) {
    if (room.label) notes.push(`AI 房間標籤：${room.label}`)
  }

  const next: Floorplan = {
    ...floorplan,
    walls,
    doors,
    windows,
    meta: {
      ...floorplan.meta,
      notes: dedupe([...(floorplan.meta.notes ?? []), ...notes, ...(proposal.notes ?? [])]),
    },
  }
  return { floorplan: parseFloorplan(next), excavations }
}

function resolveRooms(floorplan: Floorplan, proposal: AiFloorplanProposal | null): RoomAccessNode[] {
  const polys = (proposal?.rooms ?? [])
    .filter((r): r is typeof r & { polygon: Vec2[] } => Array.isArray(r.polygon) && r.polygon.length >= 3)
    .map((r) => ({
      id: r.id,
      label: r.label,
      polygon: r.polygon.map((pt) => mapProposalPoint(pt, proposal!, floorplan)),
    }))
  if (polys.length > 0) return roomsFromPolygons(polys)
  return inferRoomsFromWalls(floorplan.walls)
}

/** Merge heuristic detection with optional AI proposal, then connectivity pass. */
export function assembleFromAiAndDetect(
  detect: PipelineResult,
  proposal: AiFloorplanProposal | null,
): AssembleResult {
  const assembleNotes: string[] = []
  let floorplan = detect.floorplan
  let excavations = detect.excavations.slice()
  const diagnostics = detect.diagnostics.slice()
  const proposalUsed = proposal != null

  if (proposal) {
    assertNotFloorplanJson(proposal)
    if (proposal.kind !== "ai-proposal") {
      throw new Error("assembleFromAiAndDetect: proposal.kind must be ai-proposal")
    }
    const merged = mergeAiOpenings(floorplan, proposal, assembleNotes)
    floorplan = merged.floorplan
    excavations = merged.excavations
    diagnostics.push("merged AI proposal (candidates/OCR; not final Floorplan).")
  } else {
    assembleNotes.push("no AI proposal: heuristic detect + rules only")
  }

  const rooms = resolveRooms(floorplan, proposal)
  const conn = ensureRoomAccess(floorplan, rooms)
  floorplan = conn.floorplan
  assembleNotes.push(...conn.notes)
  if (conn.sealedRoomsFixed.length > 0) {
    diagnostics.push("connectivity fixed rooms: " + conn.sealedRoomsFixed.join(", "))
  }

  excavations = [
    ...floorplan.doors.map((d) => ({ a: d.opening.a, b: d.opening.b, kind: "door" as const })),
    ...floorplan.windows.map((w) => ({ a: w.opening.a, b: w.opening.b, kind: "window" as const })),
  ]

  const mode: AssembleUiMode = proposalUsed ? "ai+rules" : "heuristic"

  return {
    floorplan: parseFloorplan({
      ...floorplan,
      meta: {
        ...floorplan.meta,
        notes: dedupe([...(floorplan.meta.notes ?? []), ...assembleNotes]),
      },
    }),
    excavations,
    binary: detect.binary,
    diagnostics,
    mode,
    assembleNotes,
    proposalUsed,
  }
}
