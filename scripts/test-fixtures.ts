import fs from "node:fs"
import path from "node:path"
import { PNG } from "pngjs"
import { compareFloorplans } from "../src/lib/compare.ts"
import { detectFloorplan } from "../src/lib/detect/pipeline.ts"
import { evaluateWindow } from "../src/lib/detect/windows.ts"
import { wallStableId } from "../src/lib/ids.ts"
import { postprocess } from "../src/lib/postprocess.ts"
import { parseFloorplan } from "../src/lib/schema.ts"
import type { ImageSource } from "../src/lib/ink.ts"
import { fixtureExpectations } from "../src/fixtures/expectations.ts"
import { createPlan, doubleWall } from "./draw.ts"

const root = path.resolve(import.meta.dirname, "../src/fixtures")
let failed = 0

function assert(cond: boolean, message: string): void {
  if (!cond) {
    failed++
    console.error("FAIL", message)
  }
}

function loadPng(file: string): ImageSource {
  const png = PNG.sync.read(fs.readFileSync(file))
  const data = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength)
  return { width: png.width, height: png.height, data }
}

for (const spec of fixtureExpectations) {
  const image = loadPng(path.join(root, `${spec.id}.png`))
  const expected = parseFloorplan(
    JSON.parse(fs.readFileSync(path.join(root, `${spec.id}.expected.json`), "utf8")),
  )
  const result = detectFloorplan(image, `${spec.id}.png`)
  parseFloorplan(result.floorplan)
  const report = compareFloorplans(result.floorplan, expected, 0.12)
  const notes = result.floorplan.meta.notes ?? []
  console.log(
    `\n[${spec.id}] walls ${report.walls.actual}/${report.walls.expected} ` +
      `doors ${report.doors.actual}/${report.doors.expected} ` +
      `windows ${report.windows.actual}/${report.windows.expected} ` +
      `errW ${report.walls.maxErrorM.toFixed(3)} mpp ${result.floorplan.meta.metersPerPixel}`,
  )
  if (!report.ok) {
    failed++
    console.error(report.problems.join("\n"))
    console.error(notes.join("\n"))
    console.error(result.diagnostics.join("\n"))
    console.error(JSON.stringify(result.floorplan, null, 2))
  }
  assert(result.floorplan.meta.scaleTrusted === false, `${spec.id} scaleTrusted`)
  assert(result.floorplan.meta.coordinateOrigin === "bottom-left", `${spec.id} origin`)
  assert(result.floorplan.meta.ceilingHeightM === 2.8, `${spec.id} ceiling`)
  assert(result.floorplan.meta.ceilingHeightAssumed === true, `${spec.id} ceiling flag`)
  assert(Math.abs(result.floorplan.meta.metersPerPixel - 0.01) < 0.0015, `${spec.id} mpp`)
  for (const wall of result.floorplan.walls) {
    assert(wall.thicknessAssumed === true, `${spec.id} thickness assumed`)
    assert(wall.thicknessM > 0.08 && wall.thicknessM < 0.2, `${spec.id} thickness ${wall.thicknessM}`)
  }
  for (const win of result.floorplan.windows) {
    assert(win.sillHeightM === 0.9 && win.sillHeightAssumed === true, `${spec.id} sill`)
  }
  for (const phrase of spec.noteIncludes) {
    assert(notes.some((n) => n.includes(phrase)), `${spec.id} missing note ${phrase}`)
  }
  for (const phrase of spec.forbidNotes) {
    assert(!notes.some((n) => n.includes(phrase)), `${spec.id} unexpected note ${phrase}`)
  }
  const again = detectFloorplan(image, `${spec.id}.png`)
  assert(
    JSON.stringify(again.floorplan) === JSON.stringify(result.floorplan),
    `${spec.id} ids not stable`,
  )
}

{
  const png = createPlan(480, 320)
  doubleWall(png, { x: 40, y: 260 }, { x: 420, y: 70 })
  const image: ImageSource = {
    width: png.width,
    height: png.height,
    data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  }
  const result = detectFloorplan(image, "diagonal.png")
  assert(result.floorplan.walls.length === 1, `diagonal walls ${result.floorplan.walls.length}`)
  assert(result.floorplan.doors.length === 0 && result.floorplan.windows.length === 0, "diagonal openings")
  const len = Math.hypot(
    result.floorplan.walls[0].b.x - result.floorplan.walls[0].a.x,
    result.floorplan.walls[0].b.y - result.floorplan.walls[0].a.y,
  )
  assert(len > 3.4 && len < 4.6, `diagonal length ${len}`)
  if (result.floorplan.walls.length !== 1) {
    console.error(result.diagnostics.join("\n"))
    console.error(JSON.stringify(result.floorplan, null, 2))
  } else {
    console.log(`\n[diagonal] length ${len.toFixed(3)} m`)
  }
}

{
  const processed = postprocess({
    walls: [
      { a: { x: 0, y: 0 }, b: { x: 0.2, y: 0 }, thicknessM: 0.12, thicknessAssumed: true },
      { a: { x: 0, y: 1 }, b: { x: 2, y: 1 }, thicknessM: 0.12, thicknessAssumed: true },
      { a: { x: 2.8, y: 1 }, b: { x: 5, y: 1 }, thicknessM: 0.12, thicknessAssumed: true },
    ],
    doors: [],
    windows: [],
    notes: [],
    metersPerPixel: 0.01,
    scaleEstimated: true,
    sourceName: "unit",
    imageWidthPx: 100,
    imageHeightPx: 100,
  })
  assert(processed.floorplan.walls.length === 1, "short dropped and colinear merged")
  assert(
    (processed.floorplan.meta.notes ?? []).some((n) => n.includes("可能有未辨識開口")),
    "merge note",
  )
  const id = wallStableId({ x: 0, y: 1 }, { x: 5, y: 1 }, 0.12)
  assert(processed.floorplan.walls[0].id === id, "stable id matches geometry hash")
}

{
  const w = 180
  const h = 40
  const ink = new Uint8Array(w * h)
  const paint = (x0: number, x1: number, y: number) => {
    for (let x = x0; x <= x1; x++) ink[y * w + x] = 1
  }
  paint(0, 179, 10)
  paint(0, 179, 16)
  const evaled = evaluateWindow(
    ink,
    w,
    h,
    { a: { x: 40, y: 13 }, b: { x: 120, y: 13 }, thicknessPx: 12 },
    0.01,
  )
  assert(evaled.status === "extends-outside", `extends window got ${evaled.status}`)
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log("\nall fixture checks passed")
