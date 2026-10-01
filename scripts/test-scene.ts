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
  yawForDirection,
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
