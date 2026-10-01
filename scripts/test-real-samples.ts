import fs from "node:fs"
import jpeg from "jpeg-js"
import { detectFloorplan } from "../src/lib/detect/pipeline.ts"
import type { Floorplan } from "../src/types/floorplan.ts"

type Range = { walls: [number, number]; doors: [number, number]; windows: [number, number] }

const cases: {
  file: string
  notes: string[]
  range: Range
  longestM: number
  swingAtLeast?: number
  windowAtLeast?: number
  slidingAtLeast?: number
  maxXFraction?: number
}[] = [
  {
    file: "marketing-591.jpg",
    notes: ["未採信", "近黑結構線", "實心牆"],
    range: { walls: [12, 40], doors: [3, 14], windows: [2, 6] },
    longestM: 4,
    swingAtLeast: 3,
    windowAtLeast: 2,
  },
  {
    // 上方外牆 y≈160 有兩段缺口（約 x 587–682、804–920），牆墨是斷的，
    // 但缺口裡只有淺灰鋪面，沒有錯開的兩條短線，也沒有門扇加四分之一圓弧。
    // 當成拉門或平開會是猜。所以門的下限是 0，不要求拉門。
    file: "furnished-en.jpg",
    notes: ["未採信", "近黑結構線", "疑似平開門但特徵不足"],
    range: { walls: [8, 36], doors: [0, 3], windows: [2, 6] },
    longestM: 3.5,
    windowAtLeast: 2,
  },
  {
    file: "interior-design-cad.jpg",
    notes: ["未採信", "標題欄", "指北針", "疑似平開門但特徵不足"],
    range: { walls: [10, 40], doors: [3, 12], windows: [2, 6] },
    longestM: 4,
    swingAtLeast: 3,
    windowAtLeast: 2,
    maxXFraction: 0.78,
  },
]

let failed = 0
function assert(cond: boolean, message: string) {
  if (!cond) {
    failed++
    console.error("FAIL", message)
  }
}

function inRange(n: number, [lo, hi]: [number, number]) {
  return n >= lo && n <= hi
}

for (const item of cases) {
  const buf = fs.readFileSync(`src/fixtures/real-samples/${item.file}`)
  const raw = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 24, formatAsRGBA: true })
  const result = detectFloorplan(
    { width: raw.width, height: raw.height, data: new Uint8ClampedArray(raw.data) },
    item.file,
  )
  const plan: Floorplan = result.floorplan
  const notes = plan.meta.notes ?? []
  const longest = Math.max(...plan.walls.map((w) => Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y)), 0)
  const swings = plan.doors.filter((d) => d.kind === "swing" && d.swing?.arcQuarter === true)
  console.log(
    `[${item.file}] walls ${plan.walls.length} doors ${plan.doors.length} windows ${plan.windows.length} longest ${longest.toFixed(2)} m`,
  )
  assert(inRange(plan.walls.length, item.range.walls), `${item.file} wall count ${plan.walls.length}`)
  assert(inRange(plan.doors.length, item.range.doors), `${item.file} door count ${plan.doors.length}`)
  assert(inRange(plan.windows.length, item.range.windows), `${item.file} window count ${plan.windows.length}`)
  assert(longest >= item.longestM, `${item.file} longest wall ${longest.toFixed(2)}`)
  assert(plan.meta.scaleTrusted === false, `${item.file} scaleTrusted`)
  assert(plan.meta.coordinateOrigin === "bottom-left", `${item.file} origin`)
  assert(plan.meta.ceilingHeightM === 2.8 && plan.meta.ceilingHeightAssumed === true, `${item.file} ceiling`)
  assert(plan.walls.every((w) => w.thicknessAssumed === true), `${item.file} thickness assumed`)
  assert(
    plan.windows.every((w) => w.sillHeightM === 0.9 && w.sillHeightAssumed === true),
    `${item.file} sill`,
  )
  assert(
    swings.every((d) => d.swing?.openDirection === "cw" || d.swing?.openDirection === "ccw"),
    `${item.file} openDirection`,
  )
  for (const phrase of item.notes) {
    assert(notes.some((n) => n.includes(phrase)), `${item.file} missing note ${phrase}`)
  }
  if (item.swingAtLeast) assert(swings.length >= item.swingAtLeast, `${item.file} swing doors`)
  if (item.windowAtLeast) assert(plan.windows.length >= item.windowAtLeast, `${item.file} windows`)
  if (item.slidingAtLeast) {
    const sliding = plan.doors.filter((d) => d.kind === "sliding")
    assert(sliding.length >= item.slidingAtLeast, `${item.file} sliding doors`)
  }
  if (item.maxXFraction) {
    const maxX = Math.max(...plan.walls.flatMap((w) => [w.a.x, w.b.x]))
    const frac = maxX / (plan.meta.imageWidthPx * plan.meta.metersPerPixel)
    assert(frac < item.maxXFraction, `${item.file} wall reaches title block frac ${frac.toFixed(2)}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} real-sample assertion(s) failed`)
  process.exit(1)
}
console.log("\nreal samples passed")
