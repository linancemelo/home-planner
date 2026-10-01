import { z } from "zod"
import type { Floorplan } from "../types/floorplan.ts"

export const vec2Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
})

const segmentSchema = z.object({
  a: vec2Schema,
  b: vec2Schema,
})

export const wallSchema = z.object({
  id: z.string().min(1),
  a: vec2Schema,
  b: vec2Schema,
  thicknessM: z.number().positive(),
  thicknessAssumed: z.boolean().optional(),
  heightM: z.number().positive().optional(),
})

export const doorSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["swing", "sliding"]),
    wallId: z.string().min(1),
    opening: segmentSchema,
    confidence: z.number().min(0).max(1).optional(),
    swing: z
      .object({
        hinge: vec2Schema,
        leafLengthM: z.number().positive(),
        openDirection: z.enum(["cw", "ccw"]),
        arcQuarter: z.literal(true),
      })
      .optional(),
    sliding: z
      .object({
        leafA: segmentSchema,
        leafB: segmentSchema,
      })
      .optional(),
  })
  .superRefine((door, ctx) => {
    if (door.kind === "swing" && !door.swing) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "平開門必須有 swing，且 arcQuarter 為 true",
      })
    }
    if (door.kind === "sliding" && !door.sliding) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "拉門必須有 sliding 兩扇",
      })
    }
  })

export const windowSchema = z.object({
  id: z.string().min(1),
  wallId: z.string().min(1),
  opening: segmentSchema,
  confidence: z.number().min(0).max(1).optional(),
  sillHeightM: z.number().nonnegative().optional(),
  sillHeightAssumed: z.boolean().optional(),
})

export const floorplanSchema = z
  .object({
    version: z.literal(1),
    meta: z.object({
      sourceName: z.string(),
      imageWidthPx: z.number().int().positive(),
      imageHeightPx: z.number().int().positive(),
      metersPerPixel: z.number().positive(),
      scaleTrusted: z.literal(false),
      coordinateOrigin: z.enum(["bottom-left", "top-left"]),
      ceilingHeightM: z.number().positive(),
      ceilingHeightAssumed: z.literal(true),
      detectionConfidence: z.number().min(0).max(1).optional(),
      notes: z.array(z.string()).optional(),
    }),
    walls: z.array(wallSchema),
    doors: z.array(doorSchema),
    windows: z.array(windowSchema),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set(plan.walls.map((w) => w.id))
    for (const door of plan.doors) {
      if (!ids.has(door.wallId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `門 ${door.id} 的 wallId 不存在`,
        })
      }
    }
    for (const win of plan.windows) {
      if (!ids.has(win.wallId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `窗 ${win.id} 的 wallId 不存在`,
        })
      }
    }
  })

export function parseFloorplan(data: unknown): Floorplan {
  return floorplanSchema.parse(data) as Floorplan
}

const _schemaMatches: Floorplan = null as unknown as z.infer<typeof floorplanSchema>
void _schemaMatches
