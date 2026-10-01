import fs from "node:fs"
import path from "node:path"
import {
  PLAYER_RADIUS,
  buildRoom,
  directionFromYaw,
  doorBlockers,
  isBlocked,
  planToWorld,
  shortestAngle,
  worldToPlan,
  yawForDirection,
  yawToPlanDir,
} from "../src/lib/scene/room.ts"
import { parseFloorplan } from "../src/lib/schema.ts"
import type { Floorplan } from "../src/types/floorplan.ts"

const root = path.resolve(import.meta.dirname, "../src/fixtures")
let failed = 0

function assert(cond: boolean, message: string): void {
  if (!cond) {
    failed++
    console.error("FAIL", message)
  }
}

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps
}

const bl = planToWorld({ x: 1, y: 2 }, "bottom-left")
assert(bl.x === 1 && bl.z === -2, `bottom-left world ${bl.x},${bl.z}`)
const tl = planToWorld({ x: 1, y: 2 }, "top-left")
assert(tl.x === 1 && tl.z === 2, `top-left world ${tl.x},${tl.z}`)


const blBack = worldToPlan(bl.x, bl.z, "bottom-left")
assert(blBack.x === 1 && blBack.y === 2, `worldToPlan bottom-left ${blBack.x},${blBack.y}`)
const tlBack = worldToPlan(tl.x, tl.z, "top-left")
assert(tlBack.x === 1 && tlBack.y === 2, `worldToPlan top-left ${tlBack.x},${tlBack.y}`)

// yaw 0 視線沿 -Z；左下原點時平面「向上」(+Y) 對 -Z，故平面前進為 +Y。
const faceBl = yawToPlanDir(0, "bottom-left")
assert(near(faceBl.x, 0, 1e-6) && near(faceBl.y, 1, 1e-6), `yawToPlanDir bl ${faceBl.x},${faceBl.y}`)
const faceTl = yawToPlanDir(0, "top-left")
assert(near(faceTl.x, 0, 1e-6) && near(faceTl.y, -1, 1e-6), `yawToPlanDir tl ${faceTl.x},${faceTl.y}`)

for (const [dx, dz] of [
  [1, 0],
  [0, -1],
  [0, 1],
  [-1, 0],
  [0.6, -0.8],
] as const) {
  const back = directionFromYaw(yawForDirection(dx, dz))
  const len = Math.hypot(dx, dz)
  assert(near(back.x, dx / len, 1e-5) && near(back.z, dz / len, 1e-5), `yaw roundtrip ${dx},${dz}`)
}
assert(near(shortestAngle(Math.PI * 1.5), -Math.PI / 2), "shortest angle")

function loadPlan(file: string): Floorplan {
  return parseFloorplan(JSON.parse(fs.readFileSync(path.join(root, file), "utf8")))
}

const simple = buildRoom(loadPlan("simple-room.expected.json"))
assert(simple.ceiling === 2.8, "simple ceiling")
assert(simple.swings.length === 1, `simple swings ${simple.swings.length}`)
assert(simple.swings[0].openYaw < 0, `simple cw openYaw ${simple.swings[0].openYaw}`)
assert(simple.glass.length === 1, `simple glass ${simple.glass.length}`)
const sill = simple.solids.find((solid) => solid.role === "sill")
assert(!!sill && near(sill.size.y, 0.9, 0.05), "simple sill height")
assert(simple.solids.some((solid) => solid.role === "header"), "simple header")
assert(
  !isBlocked(simple.spawn.x, simple.spawn.z, PLAYER_RADIUS, [...simple.collision, ...doorBlockers(simple, {})]),
  "simple spawn blocked",
)
assert(isBlocked(1.8, -3.8, PLAYER_RADIUS, simple.collision), "simple left wall should block")

// 3D 牆心與平面中心線對齊（同一 Floorplan JSON）。
for (const wall of loadPlan("simple-room.expected.json").walls) {
  const aw = planToWorld(wall.a, "bottom-left")
  const bw = planToWorld(wall.b, "bottom-left")
  const mx = (aw.x + bw.x) / 2
  const mz = (aw.z + bw.z) / 2
  // 開口可能把牆切成多段；每段中心應落在整段中心線上
  const pieces = simple.solids.filter((s) => s.id.startsWith(wall.id))
  assert(pieces.length >= 1, `${wall.id} missing solid`)
  for (const piece of pieces) {
    const along = Math.hypot(bw.x - aw.x, bw.z - aw.z) || 1
    const t =
      ((piece.center.x - aw.x) * (bw.x - aw.x) + (piece.center.z - aw.z) * (bw.z - aw.z)) /
      (along * along)
    const cx = aw.x + (bw.x - aw.x) * t
    const cz = aw.z + (bw.z - aw.z) * t
    const perp = Math.hypot(piece.center.x - cx, piece.center.z - cz)
    assert(perp < 1e-6, `${wall.id} solid off centerline perp=${perp}`)
  }
  void mx
  void mz
}

const doorCenter = { x: 4.05, z: -2 }
assert(!isBlocked(doorCenter.x, doorCenter.z, 0.05, simple.collision), "door opening is not a solid wall")
assert(isBlocked(doorCenter.x, doorCenter.z, 0.05, doorBlockers(simple, {})), "closed swing blocks")
assert(
  !isBlocked(doorCenter.x, doorCenter.z, 0.05, doorBlockers(simple, { [simple.swings[0].id]: 1 })),
  "open swing clears the opening",
)

const two = buildRoom(loadPlan("two-room.expected.json"))
assert(two.sliders.length === 1 && two.sliders[0].leaves.length === 2, "two-room sliding leaves")
const swingGap = Math.hypot(two.swings[0].focusX - two.spawn.x, two.swings[0].focusZ - two.spawn.z)
assert(swingGap > 0.8, `two-room spawn too close to swing ${swingGap.toFixed(2)}`)
assert(two.swings.length === 1 && two.swings[0].openYaw < 0, "two-room swing cw")
const slideCenter = { x: 3, z: -2 }
assert(isBlocked(slideCenter.x, slideCenter.z, 0.05, doorBlockers(two, {})), "closed slider blocks")
assert(
  !isBlocked(slideCenter.x, slideCenter.z, 0.05, doorBlockers(two, { [two.sliders[0].id]: 1 })),
  "open slider clears the middle",
)

const flipped: Floorplan = {
  ...loadPlan("simple-room.expected.json"),
  meta: { ...loadPlan("simple-room.expected.json").meta, coordinateOrigin: "top-left" },
}
const top = buildRoom(flipped)
assert(top.swings[0].openYaw > 0, `top-left cw openYaw ${top.swings[0].openYaw}`)

for (const file of [
  "simple-room.expected.json",
  "two-room.expected.json",
  "l-shape.expected.json",
  "clutter.expected.json",
  "ambiguous-swing.expected.json",
]) {
  const room = buildRoom(loadPlan(file))
  assert(room.solids.length > 0, `${file} solids`)
  const blocked = isBlocked(room.spawn.x, room.spawn.z, PLAYER_RADIUS, [...room.collision, ...doorBlockers(room, {})])
  assert(!blocked, `${file} spawn inside geometry`)
}

if (failed > 0) {
  console.error(`\n${failed} scene assertion(s) failed`)
  process.exit(1)
}
console.log("scene geometry passed")
