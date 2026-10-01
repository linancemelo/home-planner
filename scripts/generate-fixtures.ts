import fs from "node:fs"
import path from "node:path"
import { PNG } from "pngjs"
import type { Door, Floorplan, Vec2, Wall, Window } from "../src/types/floorplan.ts"
import { doorStableId, wallStableId, windowStableId } from "../src/lib/ids.ts"
import { canonicalize, openDirectionOf } from "../src/lib/geometry.ts"
import {
  blob,
  createPlan,
  doubleWall,
  line,
  rect,
  solidWall,
  swingDoor,
  windowLines,
  arc,
} from "./draw.ts"

const root = path.resolve(import.meta.dirname, "../src/fixtures")
const mpp = 0.01

function meters(x: number, y: number, height: number): Vec2 {
  return {
    x: Math.round(x * mpp * 10000) / 10000,
    y: Math.round((height - y) * mpp * 10000) / 10000,
  }
}

function wall(a: Vec2, b: Vec2): Wall {
  const thicknessM = 0.12
  const [p, q] = canonicalize(a, b)
  return {
    id: wallStableId(p, q, thicknessM),
    a: p,
    b: q,
    thicknessM,
    thicknessAssumed: true,
  }
}

function baseMeta(
  name: string,
  width: number,
  height: number,
  notes: string[],
  confidence: number,
): Floorplan["meta"] {
  return {
    sourceName: name,
    imageWidthPx: width,
    imageHeightPx: height,
    metersPerPixel: mpp,
    scaleTrusted: false,
    coordinateOrigin: "bottom-left",
    ceilingHeightM: 2.8,
    ceilingHeightAssumed: true,
    detectionConfidence: confidence,
    notes,
  }
}

const commonNotes = [
  "圖面標註尺寸未採信（NTS）。比例由牆厚假設 0.12 m 反推，scaleTrusted 固定為 false。",
  "天花板高度假設為 2.8 m。",
  "窗台高度假設為 0.9 m。",
]

function swing(
  host: Wall,
  openingA: Vec2,
  openingB: Vec2,
  hinge: Vec2,
  leafTip: Vec2,
): Door {
  const leafLengthM = Math.round(Math.hypot(leafTip.x - hinge.x, leafTip.y - hinge.y) * 10000) / 10000
  return {
    id: doorStableId("swing", openingA, openingB, hinge),
    kind: "swing",
    wallId: host.id,
    opening: { a: openingA, b: openingB },
    confidence: 0.8,
    swing: {
      hinge,
      leafLengthM,
      openDirection: openDirectionOf(host.a, host.b, hinge, leafTip),
      arcQuarter: true,
    },
  }
}

function sliding(
  host: Wall,
  openingA: Vec2,
  openingB: Vec2,
  leafA: { a: Vec2; b: Vec2 },
  leafB: { a: Vec2; b: Vec2 },
): Door {
  return {
    id: doorStableId("sliding", openingA, openingB, null),
    kind: "sliding",
    wallId: host.id,
    opening: { a: openingA, b: openingB },
    confidence: 0.72,
    sliding: { leafA, leafB },
  }
}

function windowOf(host: Wall, a: Vec2, b: Vec2): Window {
  return {
    id: windowStableId(a, b),
    wallId: host.id,
    opening: { a, b },
    confidence: 0.75,
    sillHeightM: 0.9,
    sillHeightAssumed: true,
  }
}

function write(name: string, png: PNG, plan: Floorplan): void {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, `${name}.png`), PNG.sync.write(png))
  fs.writeFileSync(path.join(root, `${name}.expected.json`), JSON.stringify(plan, null, 2) + "\n")
}

function simpleRoom(): void {
  const w = 980
  const h = 720
  const png = createPlan(w, h)
  doubleWall(png, { x: 180, y: 520 }, { x: 180, y: 160 })
  doubleWall(png, { x: 780, y: 520 }, { x: 780, y: 160 })
  doubleWall(png, { x: 180, y: 160 }, { x: 780, y: 160 }, { from: 220, to: 340 })
  doubleWall(png, { x: 180, y: 520 }, { x: 780, y: 520 }, { from: 180, to: 270 })
  windowLines(png, { x: 400, y: 160 }, { x: 520, y: 160 })
  swingDoor(png, { x: 360, y: 520 }, { x: 360, y: 610 }, 0, 90)

  const left = wall(meters(180, 520, h), meters(180, 160, h))
  const right = wall(meters(780, 520, h), meters(780, 160, h))
  const topL = wall(meters(180, 160, h), meters(400, 160, h))
  const topR = wall(meters(520, 160, h), meters(780, 160, h))
  const botL = wall(meters(180, 520, h), meters(360, 520, h))
  const botR = wall(meters(450, 520, h), meters(780, 520, h))
  const hinge = meters(360, 520, h)
  const leaf = meters(360, 610, h)
  const plan: Floorplan = {
    version: 1,
    meta: baseMeta("simple-room.png", w, h, [...commonNotes], 0.74),
    walls: [left, right, topL, topR, botL, botR],
    doors: [swing(botL, meters(360, 520, h), meters(450, 520, h), hinge, leaf)],
    windows: [windowOf(topL, meters(400, 160, h), meters(520, 160, h))],
  }
  write("simple-room", png, plan)
}

function twoRoom(): void {
  const w = 1100
  const h = 800
  const png = createPlan(w, h)
  solidWall(png, { x: 160, y: 180 }, { x: 940, y: 180 }, 12)
  doubleWall(png, { x: 160, y: 600 }, { x: 160, y: 180 })
  doubleWall(png, { x: 940, y: 180 }, { x: 940, y: 600 }, { from: 120, to: 240 })
  doubleWall(png, { x: 160, y: 600 }, { x: 940, y: 600 }, { from: 80, to: 200 })
  doubleWall(png, { x: 520, y: 180 }, { x: 520, y: 600 }, { from: 160, to: 250 })
  windowLines(png, { x: 940, y: 300 }, { x: 940, y: 420 })
  swingDoor(png, { x: 520, y: 340 }, { x: 610, y: 340 }, 90, 0)
  line(png, { x: 250, y: 597 }, { x: 320, y: 597 })
  line(png, { x: 280, y: 603 }, { x: 350, y: 603 })

  const left = wall(meters(160, 600, h), meters(160, 180, h))
  const top = wall(meters(160, 180, h), meters(940, 180, h))
  const rightLo = wall(meters(940, 600, h), meters(940, 420, h))
  const rightHi = wall(meters(940, 300, h), meters(940, 180, h))
  const botL = wall(meters(160, 600, h), meters(240, 600, h))
  const botR = wall(meters(360, 600, h), meters(940, 600, h))
  const partHi = wall(meters(520, 340, h), meters(520, 180, h))
  const partLo = wall(meters(520, 600, h), meters(520, 430, h))
  const hinge = meters(520, 340, h)
  const leaf = meters(610, 340, h)
  const plan: Floorplan = {
    version: 1,
    meta: baseMeta(
      "two-room.png",
      w,
      h,
      [...commonNotes, "上方外牆以實心粗線繪製，仍視為牆。"],
      0.7,
    ),
    walls: [left, top, rightLo, rightHi, botL, botR, partHi, partLo],
    doors: [
      swing(partHi, meters(520, 430, h), meters(520, 340, h), hinge, leaf),
      sliding(
        botL,
        meters(240, 600, h),
        meters(360, 600, h),
        { a: meters(250, 597, h), b: meters(320, 597, h) },
        { a: meters(280, 603, h), b: meters(350, 603, h) },
      ),
    ],
    windows: [windowOf(rightHi, meters(940, 420, h), meters(940, 300, h))],
  }
  write("two-room", png, plan)
}

function lShape(): void {
  const w = 980
  const h = 740
  const png = createPlan(w, h)
  doubleWall(png, { x: 150, y: 560 }, { x: 150, y: 180 })
  doubleWall(png, { x: 150, y: 180 }, { x: 500, y: 180 }, { from: 110, to: 200 })
  doubleWall(png, { x: 500, y: 180 }, { x: 500, y: 360 })
  doubleWall(png, { x: 500, y: 360 }, { x: 820, y: 360 })
  doubleWall(png, { x: 820, y: 360 }, { x: 820, y: 560 })
  doubleWall(png, { x: 150, y: 560 }, { x: 820, y: 560 }, { from: 250, to: 340 })
  swingDoor(png, { x: 260, y: 180 }, { x: 260, y: 90 }, 0, -90)

  const left = wall(meters(150, 560, h), meters(150, 180, h))
  const topL = wall(meters(150, 180, h), meters(260, 180, h))
  const topR = wall(meters(350, 180, h), meters(500, 180, h))
  const innerV = wall(meters(500, 360, h), meters(500, 180, h))
  const innerH = wall(meters(500, 360, h), meters(820, 360, h))
  const right = wall(meters(820, 560, h), meters(820, 360, h))
  const bottom = wall(meters(150, 560, h), meters(820, 560, h))
  const hinge = meters(260, 180, h)
  const leaf = meters(260, 90, h)
  const plan: Floorplan = {
    version: 1,
    meta: baseMeta(
      "l-shape.png",
      w,
      h,
      [...commonNotes, "可能有未辨識開口。下方共線牆段中間有缺口，但沒有門或窗特徵，仍合併為同一道牆。"],
      0.62,
    ),
    walls: [left, topL, topR, innerV, innerH, right, bottom],
    doors: [swing(topL, meters(260, 180, h), meters(350, 180, h), hinge, leaf)],
    windows: [],
  }
  write("l-shape", png, plan)
}

function clutter(): void {
  const w = 1020
  const h = 780
  const png = createPlan(w, h)
  rect(png, 16, 16, w - 17, h - 17)
  rect(png, 790, 600, 990, 750)
  for (let y = 620; y <= 730; y += 16) line(png, { x: 806, y }, { x: 974, y })
  arc(png, { x: 78, y: 78 }, 16, 0, 360)
  line(png, { x: 78, y: 58 }, { x: 78, y: 48 })
  line(png, { x: 48, y: 730 }, { x: 138, y: 730 })
  for (let x = 48; x <= 138; x += 18) line(png, { x, y: 722 }, { x, y: 738 })
  blob(png, 360, 148, 6, 8)
  blob(png, 372, 148, 5, 8)
  blob(png, 382, 148, 6, 8)
  rect(png, 430, 340, 530, 420)
  doubleWall(png, { x: 906, y: 240 }, { x: 906, y: 400 })
  for (let y = 250; y < 390; y += 8) blob(png, 904, y, 4, 4)

  doubleWall(png, { x: 220, y: 560 }, { x: 220, y: 200 })
  doubleWall(png, { x: 800, y: 560 }, { x: 800, y: 200 })
  doubleWall(png, { x: 220, y: 200 }, { x: 800, y: 200 }, { from: 240, to: 360 })
  doubleWall(png, { x: 220, y: 560 }, { x: 800, y: 560 }, { from: 200, to: 290 })
  windowLines(png, { x: 460, y: 200 }, { x: 580, y: 200 })
  swingDoor(png, { x: 420, y: 560 }, { x: 420, y: 650 }, 0, 90)

  const left = wall(meters(220, 560, h), meters(220, 200, h))
  const right = wall(meters(800, 560, h), meters(800, 200, h))
  const topL = wall(meters(220, 200, h), meters(460, 200, h))
  const topR = wall(meters(580, 200, h), meters(800, 200, h))
  const botL = wall(meters(220, 560, h), meters(420, 560, h))
  const botR = wall(meters(510, 560, h), meters(800, 560, h))
  const hinge = meters(420, 560, h)
  const leaf = meters(420, 650, h)
  const plan: Floorplan = {
    version: 1,
    meta: baseMeta(
      "clutter.png",
      w,
      h,
      [
        ...commonNotes,
        "已遮罩外框線。",
        "已遮罩角落圖框或圖說區。",
        "已遮罩疑似比例尺。",
        "已遮罩疑似指北針。",
        "已移除小面積文字、尺寸數字與符號，避免被當成牆。",
        "有線段因線間距不均或夾有文字／符號，未視為牆。",
      ],
      0.66,
    ),
    walls: [left, right, topL, topR, botL, botR],
    doors: [swing(botL, meters(420, 560, h), meters(510, 560, h), hinge, leaf)],
    windows: [windowOf(topL, meters(460, 200, h), meters(580, 200, h))],
  }
  write("clutter", png, plan)
}

function ambiguous(): void {
  const w = 900
  const h = 640
  const png = createPlan(w, h)
  doubleWall(png, { x: 160, y: 480 }, { x: 160, y: 160 })
  doubleWall(png, { x: 160, y: 160 }, { x: 700, y: 160 })
  doubleWall(png, { x: 700, y: 160 }, { x: 700, y: 480 }, { from: 100, to: 190 })
  doubleWall(png, { x: 160, y: 480 }, { x: 700, y: 480 })
  line(png, { x: 700, y: 260 }, { x: 790, y: 260 })

  const plan: Floorplan = {
    version: 1,
    meta: baseMeta(
      "ambiguous-swing.png",
      w,
      h,
      [
        ...commonNotes,
        "疑似平開門但特徵不足",
        "可能有未辨識開口。右側缺口只有門扇線，沒有約四分之一圓弧，因此不輸出門，並把共線牆段合併。",
      ],
      0.48,
    ),
    walls: [
      wall(meters(160, 480, h), meters(160, 160, h)),
      wall(meters(160, 160, h), meters(700, 160, h)),
      wall(meters(700, 480, h), meters(700, 160, h)),
      wall(meters(160, 480, h), meters(700, 480, h)),
    ],
    doors: [],
    windows: [],
  }
  write("ambiguous-swing", png, plan)
}

simpleRoom()
twoRoom()
lShape()
clutter()
ambiguous()
console.log("fixtures written to", root)
