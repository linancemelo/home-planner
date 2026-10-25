/** M9 smoke: buildScene uses assembleFurnishing; spawn not blocked. */
import { generateLayout } from "../src/game/layout/generateLayout.ts"
import { autoFurnish } from "../src/game/furnish/autoFurnish.ts"
import { blocked, colliders, makeInteractables } from "../src/game/scene/walk.ts"
import { buildScene } from "../src/game/scene/buildScene.ts"
import { layoutFromBlueprint } from "../src/game/layout/fromBlueprint.ts"
import { createDefaultBlueprint } from "../src/plan/data/defaultApartment.ts"
import { assembleFurnishing } from "../src/scene3d/assembleFurnishing.ts"

const layout = generateLayout({ bedrooms: 2, livings: 1, baths: 1, kitchen: "open", seed: 1 })
const furn = autoFurnish(layout)
const boxes = colliders(layout, furn.items, makeInteractables(layout, furn.items))
const [sx, sy] = layout.spawn.at
const spawnBlocked = blocked(sx, sy, boxes)
console.log("config spawn blocked?", spawnBlocked, "items", furn.items.length)

const h = buildScene(layout, furn.items)
let furnMeshes = 0
h.scene.traverse((o) => { if ((o as any).userData?.fid) furnMeshes++ })
console.log("buildScene furniture groups (fid)", furnMeshes, "expect", furn.items.length)
h.dispose()

const ed = layoutFromBlueprint(createDefaultBlueprint(), [])
if ("error" in ed) throw new Error(ed.error)
const boxes2 = colliders(ed.layout, ed.items, makeInteractables(ed.layout, ed.items))
const [ex, ey] = ed.layout.spawn.at
console.log("editor-empty spawn blocked?", blocked(ex, ey, boxes2), "items", ed.items.length)

const g = assembleFurnishing({ id: "t", type: "bed", w: 1800, d: 2000, cx: 1000, cy: 1000, rot: 0, color: "#c9d6df" })
console.log("assemble bed children", g.children.length, "pos", g.position.toArray())

if (spawnBlocked) throw new Error("config spawn blocked")
if (furnMeshes !== furn.items.length) throw new Error(`fid count ${furnMeshes} != ${furn.items.length}`)
if (blocked(ex, ey, boxes2)) throw new Error("editor spawn blocked")
if (g.children.length < 3) throw new Error("bed mesh too simple")
console.log("M9 smoke OK")
