/**
 * AiFloorplanProposal — typed AI *proposal* for floor-plan recognition.
 *
 * HARD CONTRACT: the model MUST NOT emit final Floorplan JSON or PlanBlueprint.
 * Downstream assembleFromAiAndDetect + postprocess/parseFloorplan own the
 * authoritative geometry, IDs, excavations, and schema validation.
 */
import { z } from "zod"
import { vec2Schema } from "../schema.ts"

/** Pixel / metre / normalized spaces the assembler understands. */
export const aiCoordinateSpaceSchema = z.enum([
  "meters-bottom-left",
  "pixels-top-left",
  "normalized-top-left",
])

export const aiRoomHintSchema = z.object({
  id: z.string().min(1).optional(),
  /** OCR / legend room name (e.g. 客廳). */
  label: z.string().optional(),
  /** Optional room polygon in `coordinateSpace`. */
  polygon: z.array(vec2Schema).min(3).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const aiWallHintSchema = z.object({
  a: vec2Schema,
  b: vec2Schema,
  /** Furniture segments are ignored by assemble (furniture ≠ structure). */
  role: z.enum(["structure", "furniture", "uncertain"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const aiDoorCandidateSchema = z.object({
  openingA: vec2Schema,
  openingB: vec2Schema,
  kind: z.enum(["swing", "sliding", "opening"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
})

export const aiWindowCandidateSchema = z.object({
  openingA: vec2Schema,
  openingB: vec2Schema,
  confidence: z.number().min(0).max(1).optional(),
})

export const aiOcrLabelSchema = z.object({
  text: z.string().min(1),
  at: vec2Schema,
  confidence: z.number().min(0).max(1).optional(),
})

/**
 * Proposal-only schema. `kind` is fixed so parsers reject accidental Floorplan payloads.
 * There is intentionally no `walls`/`doors`/`windows` Floorplan-shaped fields here.
 */
export const aiFloorplanProposalSchema = z.object({
  version: z.literal(1),
  kind: z.literal("ai-proposal"),
  coordinateSpace: aiCoordinateSpaceSchema,
  rooms: z.array(aiRoomHintSchema).optional(),
  wallHints: z.array(aiWallHintSchema).optional(),
  doorCandidates: z.array(aiDoorCandidateSchema).optional(),
  windowCandidates: z.array(aiWindowCandidateSchema).optional(),
  ocrLabels: z.array(aiOcrLabelSchema).optional(),
  notes: z.array(z.string()).optional(),
  model: z.string().optional(),
})

export type AiCoordinateSpace = z.infer<typeof aiCoordinateSpaceSchema>
export type AiRoomHint = z.infer<typeof aiRoomHintSchema>
export type AiWallHint = z.infer<typeof aiWallHintSchema>
export type AiDoorCandidate = z.infer<typeof aiDoorCandidateSchema>
export type AiWindowCandidate = z.infer<typeof aiWindowCandidateSchema>
export type AiOcrLabel = z.infer<typeof aiOcrLabelSchema>
export type AiFloorplanProposal = z.infer<typeof aiFloorplanProposalSchema>

export function parseAiFloorplanProposal(data: unknown): AiFloorplanProposal {
  return aiFloorplanProposalSchema.parse(data)
}

/** Docs helper: reject anything that looks like Floorplan v1. */
export function assertNotFloorplanJson(data: unknown): void {
  if (
    data &&
    typeof data === "object" &&
    (data as { version?: unknown }).version === 1 &&
    Array.isArray((data as { walls?: unknown }).walls) &&
    Array.isArray((data as { doors?: unknown }).doors) &&
    !("kind" in (data as object) && (data as { kind?: string }).kind === "ai-proposal")
  ) {
    throw new Error(
      "AiFloorplanProposal contract violated: model must not emit final Floorplan JSON.",
    )
  }
}
