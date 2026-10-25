/** 由戶型＋家具建 three.js 場景（公尺；平面 x→x、y→z）。門、落地窗、窗、冰箱門可動畫開關。 */
import * as THREE from "three"
import type { GeneratedLayout, RoomKind } from "../layout/types.ts"
import type { GameFurniture } from "../furnish/autoFurnish.ts"
import { assembleFurnishing } from "../../scene3d/assembleFurnishing.ts"
import { H, type Interactable, slidePanels } from "./walk.ts"

const M = 1 / 1000
const FLOOR: Record<RoomKind, number> = { living: 0xd9b48a, bedroom: 0xc9a27a, bath: 0xdfe6ea, kitchen: 0xe2d6c4, balcony: 0xb9b2a6, storage: 0xcdbfa8, study: 0xc9a27a, hall: 0xd6b591 }

const mat = (c: number | string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, ...o })
function box(x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, m: THREE.Material) {
  const g = new THREE.Mesh(new THREE.BoxGeometry(Math.max(1, x1 - x0) * M, Math.max(1, y1 - y0) * M, Math.max(1, z1 - z0) * M), m)
  g.position.set(((x0 + x1) / 2) * M, ((y0 + y1) / 2) * M, ((z0 + z1) / 2) * M)
  g.castShadow = g.receiveShadow = true
  return g
}
const angleOf = (v: readonly number[]) => Math.atan2(-v[1], v[0]) // 讓本地 +x 指向平面向量 v

export type SceneHandle = { scene: THREE.Scene; tick: (dt: number) => void; apply: (st: Interactable[]) => void; dispose: () => void }

export function buildScene(g: GeneratedLayout, items: GameFurniture[]): SceneHandle {
  const bp = g.blueprint, scene = new THREE.Scene()
  scene.background = new THREE.Color(0xbfe3f5)
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd8c8b0, 1.4), new THREE.AmbientLight(0xffffff, 0.5))
  const sun = new THREE.DirectionalLight(0xffffff, 1.2)
  sun.position.set(8, 14, 6)
  scene.add(sun)
  const b = bp.bounds
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(b.w * M + 40, b.h * M + 40), mat(0x9cc58a))
  ground.rotation.x = -Math.PI / 2
  ground.position.set((b.x + b.w / 2) * M, -0.02, (b.y + b.h / 2) * M)
  scene.add(ground)
  const wallM = mat(0xf4efe6), extM = mat(0xe9e1d3), railM = mat(0x8f8a82, { metalness: 0.3 }), glassM = mat(0xa9d6ee, { transparent: true, opacity: 0.35, roughness: 0.1 })
  const frameM = mat(0x6b6158), leafM = mat(0xb98d62), entryM = mat(0x8a4b2a), ceilM = mat(0xfbf8f2, { side: THREE.DoubleSide, emissive: 0xfbf8f2, emissiveIntensity: 0.55 })
  // 地板與天花板
  for (const r of bp.planRooms) {
    const sh = new THREE.Shape(r.poly.map(([x, y]) => new THREE.Vector2(x * M, -y * M)))
    const fl = new THREE.Mesh(new THREE.ShapeGeometry(sh), mat(FLOOR[g.kinds[r.id]] ?? 0xcccccc))
    fl.rotation.x = -Math.PI / 2
    fl.receiveShadow = true
    scene.add(fl)
    if (g.kinds[r.id] !== "balcony") {
      const ce = new THREE.Mesh(new THREE.ShapeGeometry(sh), ceilM)
      ce.rotation.x = -Math.PI / 2
      ce.position.y = H.ceiling * M
      scene.add(ce)
    }
  }
  // 牆
  for (const w of bp.walls) scene.add(box(w[0], w[1], w[2], w[3], 0, w[4] === "low" ? 1050 : H.ceiling, w[4] === "low" ? railM : w[4] === "e" ? extM : wallM))
  const anims: ((dt: number) => void)[] = [], dyn = new Map<string, (open: boolean) => void>()
  // speed＝以 60 fps 為準的每幀步長；實際乘 dt，開關速度與幀率無關
  const lerp = (o: { cur: number; tgt: number }, set: (v: number) => void, speed: number) => anims.push((dt: number) => { if (o.cur !== o.tgt) { const d = o.tgt - o.cur, s = Math.sign(d) * Math.min(Math.abs(d), speed * 60 * dt); o.cur += s; set(o.cur) } })
  // 窗：窗台、窗頂、兩片可推拉玻璃
  bp.windowOpenings.forEach((w, i) => {
    scene.add(box(w[0], w[1], w[2], w[3], 0, H.sill, wallM), box(w[0], w[1], w[2], w[3], H.winTop, H.ceiling, wallM))
    const horiz = w[2] - w[0] >= w[3] - w[1], L = horiz ? w[2] - w[0] : w[3] - w[1], c = horiz ? (w[1] + w[3]) / 2 : (w[0] + w[2]) / 2
    const pane = (u0: number, u1: number, off: number) => (horiz ? box(w[0] + u0, c + off - 10, w[0] + u1, c + off + 10, H.sill, H.winTop, glassM) : box(c + off - 10, w[1] + u0, c + off + 10, w[1] + u1, H.sill, H.winTop, glassM))
    const p1 = pane(0, L / 2 + 20, -25), p2 = pane(L / 2 - 20, L, 25)
    scene.add(p1, p2)
    const base = p2.position.clone(), st = { cur: 0, tgt: 0 }
    lerp(st, (v) => { p2.position.copy(base); if (horiz) p2.position.x -= v * M; else p2.position.z -= v * M }, 30)
    dyn.set(`window:${i}`, (open) => { st.tgt = open ? L / 2 - 40 : 0 })
  })
  // 落地窗：上方門楣、兩片玻璃門
  bp.slidingDoors.forEach((s, i) => {
    const r = s.rect
    scene.add(box(r[0], r[1], r[2], r[3], H.door, H.ceiling, wallM))
    const [a, c] = slidePanels(s, false), horiz = r[2] - r[0] >= r[3] - r[1]
    const off = (bx: number[], o: number) => (horiz ? [bx[0], bx[1] + o, bx[2], bx[3] + o] : [bx[0] + o, bx[1], bx[2] + o, bx[3]])
    const p1 = box(...(off(a, 0) as [number, number, number, number]), 0, H.door, glassM), p2 = box(...(off(c, 0) as [number, number, number, number]), 0, H.door, glassM)
    for (const p of [p1, p2]) p.add(new THREE.LineSegments(new THREE.EdgesGeometry((p.geometry as THREE.BoxGeometry)), new THREE.LineBasicMaterial({ color: 0x6b6158 })))
    scene.add(p1, p2)
    const base = p2.position.clone(), L = horiz ? r[2] - r[0] : r[3] - r[1], st = { cur: 0, tgt: 0 }
    lerp(st, (v) => { p2.position.copy(base); if (horiz) p2.position.x -= v * M; else p2.position.z -= v * M }, 40)
    dyn.set(`slide:${i}`, (open) => { st.tgt = open ? L / 2 - 20 : 0 })
  })
  // 平開門：門楣＋繞鉸鏈轉的門片
  bp.swingDoors.forEach((d, i) => {
    const r = d.rect
    scene.add(box(r[0], r[1], r[2], r[3], H.door, H.ceiling, wallM))
    const pivot = new THREE.Group()
    pivot.position.set(d.h[0] * M, 0, d.h[1] * M)
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(d.len * M, H.door * M - 0.01, 0.04), d.entry ? entryM : leafM)
    leaf.position.set((d.len / 2) * M, (H.door / 2) * M, 0)
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.03), frameM)
    knob.position.set(d.len * M - 0.08, 1.0, 0.04)
    const knob2 = knob.clone(); knob2.position.z = -0.04
    pivot.add(leaf, knob, knob2)
    const a0 = angleOf(d.c), a1 = angleOf(d.o)
    let da = a1 - a0
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    pivot.rotation.y = a0
    scene.add(pivot)
    const st = { cur: 0, tgt: 0 }
    lerp(st, (v) => { pivot.rotation.y = a0 + da * v }, 0.05)
    dyn.set(`swing:${i}`, (open) => { st.tgt = open ? 1 : 0 })
  })
  // 家具：與編輯器鳥瞰同一套 assembleFurnishing 細網格（D-29：各模式視覺統一）
  // 冰箱門片仍可開合（互動／碰撞走 walk.ts；門片蓋在細網格正面上作為開關回饋）
  for (const it of items) {
    scene.add(assembleFurnishing(it))
    if (it.type !== "fridge") continue
    const h = 1800
    const n = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0]
    const t: [number, number] = [-n[1], n[0]]
    const hx = it.cx + n[0] * (it.d / 2 - 25) - t[0] * (it.w / 2), hz = it.cy + n[1] * (it.d / 2 - 25) - t[1] * (it.w / 2)
    const pivot = new THREE.Group()
    pivot.position.set(hx * M, 0, hz * M)
    const door = new THREE.Mesh(new THREE.BoxGeometry(it.w * M, (h - 20) * M, 0.05), mat(0xeef1f3, { metalness: 0.2, roughness: 0.4 }))
    door.position.set((it.w / 2) * M, (h / 2) * M, 0)
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.5, 0.03), frameM)
    handle.position.set(it.w * M - 0.06, 1.1, 0.04)
    pivot.add(door, handle)
    const a0 = angleOf(t), a1 = angleOf(n)
    let da = a1 - a0
    while (da > Math.PI) da -= 2 * Math.PI
    while (da < -Math.PI) da += 2 * Math.PI
    pivot.rotation.y = a0
    scene.add(pivot)
    const st = { cur: 0, tgt: 0 }
    lerp(st, (v) => { pivot.rotation.y = a0 + da * v }, 0.06)
    dyn.set(`fridge:${it.id}`, (open) => { st.tgt = open ? 1 : 0 })
  }

  return {
    scene,
    tick: (dt) => { for (const a of anims) a(dt) },
    apply: (sts) => { for (const s of sts) dyn.get(s.kind === "fridge" ? `fridge:${s.id}` : `${s.kind}:${s.i}`)?.(s.open) },
    dispose: () => scene.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose() } }),
  }
}
