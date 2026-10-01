/**
 * Smoke test: run canvas detector on simple-room (+ optional fixtures)
 * and convert to PlanBlueprint. Usage: npm run test:detect
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { PNG } from "pngjs"
import { detectFloorplan } from "../src/import-plan/detect/pipeline.ts"
import { parseFloorplan } from "../src/import-plan/schema.ts"
import { compareFloorplans } from "../src/import-plan/compare.ts"
import { floorplanToBlueprint } from "../src/import-plan/floorplanToBlueprint.ts"
import type { ImageSource } from "../src/import-plan/ink.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, "../src/import-plan/fixtures")
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

const ids = ["simple-room", "two-room", "l-shape"]

for (const id of ids) {
  const pngPath = path.join(root, `${id}.png`)
  const expPath = path.join(root, `${id}.expected.json`)
  if (!fs.existsSync(pngPath) || !fs.existsSync(expPath)) {
    console.warn("skip missing", id)
    continue
  }
  const image = loadPng(pngPath)
  const expected = parseFloorplan(JSON.parse(fs.readFileSync(expPath, "utf8")))
  const result = detectFloorplan(image, `${id}.png`)
  parseFloorplan(result.floorplan)
  const report = compareFloorplans(result.floorplan, expected, 0.12)
  console.log(
    `\n[${id}] walls ${report.walls.actual}/${report.walls.expected} ` +
      `doors ${report.doors.actual}/${report.doors.expected} ` +
      `windows ${report.windows.actual}/${report.windows.expected} ` +
      `ok=${report.ok}`,
  )
  assert(result.floorplan.meta.scaleTrusted === false, `${id} scaleTrusted`)
  assert(result.floorplan.meta.coordinateOrigin === "bottom-left", `${id} origin`)
  assert(Math.abs(result.floorplan.meta.metersPerPixel - 0.01) < 0.0015, `${id} mpp`)
  if (!report.ok) {
    failed++
    console.error(report.problems.join("\n"))
  }

  const bp = floorplanToBlueprint(result.floorplan)
  assert(bp.source === "import", `${id} blueprint source`)
  assert(bp.walls.length > 0, `${id} blueprint walls`)
  assert(bp.planRooms.length >= 1, `${id} blueprint rooms`)
  assert(bp.bounds.w > 0 && bp.bounds.h > 0, `${id} bounds`)
  assert(Number.isFinite(bp.origin.ox) && Number.isFinite(bp.origin.oy), `${id} origin mm`)
  console.log(
    `  blueprint walls=${bp.walls.length} swing=${bp.swingDoors.length} ` +
      `slide=${bp.slidingDoors.length} wins=${bp.windowOpenings.length} ` +
      `room=${bp.planRooms[0]?.name} notes=${bp.notes?.length ?? 0}`,
  )
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log("\nAll detect smoke checks passed.")
