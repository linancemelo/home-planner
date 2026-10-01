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
import { evaluateDoor, findFaintGapSwings, findOpeningSliders, findSlidingsOnWalls, findSwingsOnWalls } from "./doors.ts"
import { doorStrokes, faintStrokes, thinStrokes } from "./strokes.ts"
import { detectWallFragments, findPixelGaps, type WallFragment } from "./walls.ts"
import { evaluateWindow, findWindowsOnWalls } from "./windows.ts"

export type PipelineResult = {
  floorplan: Floorplan
  excavations: Excavation[]
  binary: { width: number; height: number; ink: Uint8Array }
  diagnostics: string[]
}

/** 共線牆段合成一條搜尋線，讓跨在缺口上的拉門與窗還看得到整道牆。 */
function colinearSearchLines(fragments: WallFragment[]): WallFragment[] {
  const used = new Array(fragments.length).fill(false)
  const out: WallFragment[] = []
  for (let i = 0; i < fragments.length; i++) {
    if (used[i]) continue
    const base = fragments[i]
    const dx = base.b.x - base.a.x
    const dy = base.b.y - base.a.y
    const len = Math.hypot(dx, dy) || 1
    const dirX = dx / len
    const dirY = dy / len
    const nx = -dirY
    const ny = dirX
    let t0 = 0
    let t1 = len
    let thick = base.thicknessPx
    used[i] = true
    let changed = true
    while (changed) {
      changed = false
      for (let j = 0; j < fragments.length; j++) {
        if (used[j]) continue
        const frag = fragments[j]
        const fx = frag.b.x - frag.a.x
        const fy = frag.b.y - frag.a.y
        const fl = Math.hypot(fx, fy) || 1
        if (Math.abs(dirX * fy - dirY * fx) / fl > 0.12) continue
        const perpA = Math.abs((frag.a.x - base.a.x) * nx + (frag.a.y - base.a.y) * ny)
        const perpB = Math.abs((frag.b.x - base.a.x) * nx + (frag.b.y - base.a.y) * ny)
        if (perpA > 5 || perpB > 5) continue
        const p0 = (frag.a.x - base.a.x) * dirX + (frag.a.y - base.a.y) * dirY
        const p1 = (frag.b.x - base.a.x) * dirX + (frag.b.y - base.a.y) * dirY
        const lo = Math.min(p0, p1)
        const hi = Math.max(p0, p1)
        if (lo > t1 + 180 || hi < t0 - 180) continue
        t0 = Math.min(t0, lo)
        t1 = Math.max(t1, hi)
        thick = Math.max(thick, frag.thicknessPx)
        used[j] = true
        changed = true
      }
    }
    out.push({
      a: { x: base.a.x + dirX * t0, y: base.a.y + dirY * t0 },
      b: { x: base.a.x + dirX * t1, y: base.a.y + dirY * t1 },
      thicknessPx: thick,
      kind: base.kind,
    })
  }
  return out
}

function openingClash(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const mid1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const mid2 = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }
  const len = Math.min(dist(a, b), dist(c, d))
  return dist(mid1, mid2) < Math.max(12, len * 0.5)
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

  const strokes = thinStrokes(pre.gray, pre.width, pre.height)
  const openingInk = pre.cleaned.slice()
  for (let i = 0; i < openingInk.length; i++) {
    if (strokes[i]) openingInk[i] = 1
  }

  const gaps = findPixelGaps(walls.fragments, walls.metersPerPixel, walls.illustrative)
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

  const clashes = (a: Vec2, b: Vec2) =>
    pxDoors.some((door) => openingClash(a, b, door.openingA, door.openingB)) ||
    pxWindows.some((win) => openingClash(a, b, win.openingA, win.openingB))

  for (const gap of gaps) {
    const door = evaluateDoor(openingInk, pre.width, pre.height, gap, walls.metersPerPixel)
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

    const win = evaluateWindow(openingInk, pre.width, pre.height, gap, walls.metersPerPixel)
    if (win.status === "window") {
      pxWindows.push({ openingA: gap.a, openingB: gap.b, confidence: win.confidence })
      continue
    }
    if (door.status === "partial") {
      pxNotes.push("疑似平開門但特徵不足")
      continue
    }
    if (win.status === "cavity") pxNotes.push("待查：可能空心牆腔")
    else if (win.status === "insufficient") pxNotes.push("疑似窗戶但平行線不足，已略過。")
    else if (win.status === "extends-outside") pxNotes.push("疑似窗戶但線段超出牆外，已略過。")
    else if (win.status === "closed-rect") pxNotes.push("疑似窗戶但形狀像封閉小矩形，已略過。")
  }

  const swingInk = doorStrokes(pre.gray, pre.width, pre.height)
  for (let i = 0; i < swingInk.length; i++) {
    if (pre.cleaned[i] && !pre.thick[i]) swingInk[i] = 1
  }
  const faintInk = faintStrokes(pre.gray, pre.width, pre.height)
  for (let i = 0; i < faintInk.length; i++) {
    if (swingInk[i]) faintInk[i] = 1
  }
  const searchLines = colinearSearchLines(walls.fragments)

  for (const swing of findFaintGapSwings(
    faintInk,
    pre.width,
    pre.height,
    gaps,
    walls.fragments,
    walls.metersPerPixel,
  )) {
    if (clashes(swing.openingA, swing.openingB)) continue
    pxDoors.push({
      kind: "swing",
      openingA: swing.openingA,
      openingB: swing.openingB,
      hinge: swing.hinge,
      leafTip: swing.leafTip,
      leafLengthPx: swing.leafLengthPx,
      confidence: swing.confidence,
    })
  }

  for (const swing of findSwingsOnWalls(
    swingInk,
    pre.width,
    pre.height,
    searchLines,
    walls.metersPerPixel,
  )) {
    if (clashes(swing.openingA, swing.openingB)) continue
    pxDoors.push({
      kind: "swing",
      openingA: swing.openingA,
      openingB: swing.openingB,
      hinge: swing.hinge,
      leafTip: swing.leafTip,
      leafLengthPx: swing.leafLengthPx,
      confidence: swing.confidence,
    })
  }
  for (const slide of findOpeningSliders(
    pre.gray,
    pre.width,
    pre.height,
    gaps,
    walls.metersPerPixel,
    swingInk,
  )) {
    if (clashes(slide.openingA, slide.openingB)) continue
    pxDoors.push({
      kind: "sliding",
      openingA: slide.openingA,
      openingB: slide.openingB,
      sliding: slide,
      confidence: slide.confidence,
    })
  }
  for (const slide of findSlidingsOnWalls(
    openingInk,
    pre.width,
    pre.height,
    searchLines,
    walls.metersPerPixel,
  )) {
    if (clashes(slide.openingA, slide.openingB)) continue
    pxDoors.push({
      kind: "sliding",
      openingA: slide.openingA,
      openingB: slide.openingB,
      sliding: slide,
      confidence: slide.confidence,
    })
  }
  for (const win of findWindowsOnWalls(
    openingInk,
    pre.gray,
    pre.cleaned,
    pre.width,
    pre.height,
    searchLines,
    walls.metersPerPixel,
    pxNotes,
  )) {
    if (clashes(win.openingA, win.openingB)) continue
    pxWindows.push(win)
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
