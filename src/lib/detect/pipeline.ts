import type { Excavation, Floorplan, Vec2 } from "../../types/floorplan.ts"
import { dist, pixelToMeter, roundM } from "../geometry.ts"
import { downsample, type ImageSource } from "../ink.ts"
import { preprocess } from "../preprocess.ts"
import { postprocess, type DraftDoor, type DraftWall, type DraftWindow } from "../postprocess.ts"
import { parseFloorplan } from "../schema.ts"
import {
  DEFAULT_CEILING_HEIGHT_M,
  DEFAULT_WALL_THICKNESS_M,
} from "../units.ts"
import { evaluateDoor } from "./doors.ts"
import { detectWallFragments, findPixelGaps } from "./walls.ts"
import { evaluateWindow } from "./windows.ts"

export type PipelineResult = {
  floorplan: Floorplan
  excavations: Excavation[]
  binary: { width: number; height: number; ink: Uint8Array }
  diagnostics: string[]
}

const SCALE_NOTE =
  "圖面標註尺寸未採信（NTS）。比例由牆厚假設 0.12 m 反推，scaleTrusted 固定為 false。"
const CEILING_NOTE = `天花板高度假設為 ${DEFAULT_CEILING_HEIGHT_M} m。`
const SILL_NOTE = "窗台高度假設為 0.9 m。"

export function detectFloorplan(image: ImageSource, sourceName: string): PipelineResult {
  const { image: working, scale } = downsample(image, 1600)
  const pre = preprocess(working)
  const diagnostics = [
    `影像 ${image.width}×${image.height} px，處理解析度 ${working.width}×${working.height}。`,
  ]
  if (scale < 0.999) diagnostics.push(`長邊超過 1600 px，已縮小 ${(scale * 100).toFixed(0)}% 再辨識。`)

  const walls = detectWallFragments(pre.lines, pre.raw, pre.cleaned, pre.width, pre.height)
  diagnostics.push(...walls.diagnostics)

  const gaps = findPixelGaps(walls.fragments, walls.metersPerPixel)
  diagnostics.push(`共線缺口 ${gaps.length} 處。`)

  const pxNotes: string[] = []
  const pxDoors: {
    kind: "swing" | "sliding"
    openingA: Vec2
    openingB: Vec2
    confidence: number
    hinge?: Vec2
    leafTip?: Vec2
    leafLengthPx?: number
    sliding?: DraftDoor["sliding"]
  }[] = []
  const pxWindows: { openingA: Vec2; openingB: Vec2; confidence: number }[] = []

  for (const gap of gaps) {
    const door = evaluateDoor(pre.cleaned, pre.width, pre.height, gap, walls.metersPerPixel)
    if (door.status === "swing") {
      pxDoors.push({
        kind: "swing",
        openingA: gap.a,
        openingB: gap.b,
        hinge: door.hinge,
        leafTip: door.leafTip,
        leafLengthPx: door.leafLengthPx,
        confidence: door.confidence,
      })
      continue
    }
    if (door.status === "sliding") {
      pxDoors.push({
        kind: "sliding",
        openingA: gap.a,
        openingB: gap.b,
        sliding: door,
        confidence: door.confidence,
      })
      continue
    }

    const win = evaluateWindow(pre.cleaned, pre.width, pre.height, gap, walls.metersPerPixel)
    if (win.status === "window") {
      pxWindows.push({ openingA: gap.a, openingB: gap.b, confidence: win.confidence })
      continue
    }
    if (door.status === "partial") {
      pxNotes.push("疑似平開門但特徵不足")
      continue
    }
    if (win.status === "insufficient") pxNotes.push("疑似窗戶但平行線不足，已略過。")
    else if (win.status === "extends-outside") pxNotes.push("疑似窗戶但線段超出牆外，已略過。")
    else if (win.status === "closed-rect") pxNotes.push("疑似窗戶但形狀像封閉小矩形，已略過。")
  }

  diagnostics.push(`平開／拉門 ${pxDoors.length}，窗 ${pxWindows.length}。`)

  const toMeter = (p: Vec2) => {
    const original = { x: p.x / scale, y: p.y / scale }
    return pixelToMeter(original, image.height, walls.metersPerPixel * scale)
  }

  const draftWalls: DraftWall[] = walls.fragments.map((frag) => ({
    a: toMeter(frag.a),
    b: toMeter(frag.b),
    thicknessM: roundM(frag.thicknessPx * walls.metersPerPixel),
    thicknessAssumed: true,
  }))

  const draftDoors: DraftDoor[] = pxDoors.map((door) => {
    const openingA = toMeter(door.openingA)
    const openingB = toMeter(door.openingB)
    if (door.kind === "swing" && door.hinge && door.leafTip && door.leafLengthPx) {
      const hinge = toMeter(door.hinge)
      const leafTip = toMeter(door.leafTip)
      return {
        kind: "swing" as const,
        openingA,
        openingB,
        hinge,
        leafTip,
        leafLengthM: dist(hinge, leafTip),
        confidence: door.confidence,
      }
    }
    return {
      kind: "sliding" as const,
      openingA,
      openingB,
      confidence: door.confidence,
      sliding: door.sliding
        ? {
            leafA: { a: toMeter(door.sliding.leafA.a), b: toMeter(door.sliding.leafA.b) },
            leafB: { a: toMeter(door.sliding.leafB.a), b: toMeter(door.sliding.leafB.b) },
          }
        : undefined,
    }
  })

  const draftWindows: DraftWindow[] = pxWindows.map((win) => ({
    openingA: toMeter(win.openingA),
    openingB: toMeter(win.openingB),
    confidence: win.confidence,
  }))

  const notes = [SCALE_NOTE, CEILING_NOTE, SILL_NOTE, ...pre.notes, ...walls.notes, ...pxNotes]
  if (draftWalls.length === 0) {
    notes.push("沒有找到夠清楚的雙線或實心牆，未輸出牆段。")
  }
  notes.push(`牆厚預設 ${DEFAULT_WALL_THICKNESS_M} m。看不清楚的開口不會補猜。`)

  const processed = postprocess({
    walls: draftWalls,
    doors: draftDoors,
    windows: draftWindows,
    notes,
    metersPerPixel: walls.metersPerPixel * scale,
    scaleEstimated: walls.scaleEstimated,
    sourceName,
    imageWidthPx: image.width,
    imageHeightPx: image.height,
  })

  const floorplan = parseFloorplan(processed.floorplan)
  return {
    floorplan,
    excavations: processed.excavations,
    binary: { width: pre.width, height: pre.height, ink: pre.cleaned },
    diagnostics,
  }
}
