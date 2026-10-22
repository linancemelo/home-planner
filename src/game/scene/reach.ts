/**
 * 遊戲碰撞模型下的可達性（測試、自動家具、遊戲共用同一份碰撞盒：walk.ts colliders）。
 * 玩家半徑 0.2 m；平開門開＝門片轉到 90°；家具＝外框碰撞盒；落地窗開。
 * 起點：大門內側。目標：每個房間、每件設備（洗衣機／馬桶／浴櫃／淋浴／床／衣櫃／冰箱／爐）前方 0.30–0.55 m 的站位。
 * 先試「全部門開」；有目標走不到時，再試「只關一扇門」的每一種，任一門狀態走得到即可。
 */
import type { GeneratedLayout } from "../layout/types.ts"
import { autoFurnish, type GameFurniture } from "../furnish/autoFurnish.ts"
import { pointInPoly } from "../layout/validateLayout.ts"
import { colliders, leafBox, makeInteractables, PLAYER_R, type Box } from "./walk.ts"

type P = [number, number]
export const FIXTURE_SLOTS = new Set(["washer", "toilet", "vanity", "shower", "bed", "wardrobe", "fridge", "stove"])

/** 設備前方站位（前方 300–550 mm；床另含兩側）。 */
export function standPoints(it: { cx: number; cy: number; w: number; d: number; rot: number; slot?: string; type: string }): P[] {
  const n: P = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0]
  const ds = [300, 350, 400, 450, 500, 550]
  const pts: P[] = ds.map((d) => [it.cx + n[0] * (it.d / 2 + d), it.cy + n[1] * (it.d / 2 + d)])
  if (it.type === "bed") {
    const side: P = it.rot % 180 === 0 ? [1, 0] : [0, 1]
    for (const s of [-1, 1]) for (const d of ds) pts.push([it.cx + side[0] * s * (it.w / 2 + d), it.cy + side[1] * s * (it.w / 2 + d)])
  }
  return pts
}

/** 碰撞盒點陣化：格點中心離任何盒子 < r 即不可站。 */
function rasterize(g: GeneratedLayout, boxes: Box[], r = PLAYER_R, GRID = 50) {
  const b = g.blueprint.bounds, x0 = b.x - 2000, y0 = b.y - 2000
  const nx = Math.ceil((b.w + 4000) / GRID) + 1, ny = Math.ceil((b.h + 4000) / GRID) + 1
  const bad = new Uint8Array(nx * ny)
  for (const q of boxes) {
    const i0 = Math.max(0, Math.floor((q[0] - r - x0) / GRID)), i1 = Math.min(nx - 1, Math.ceil((q[2] + r - x0) / GRID))
    const j0 = Math.max(0, Math.floor((q[1] - r - y0) / GRID)), j1 = Math.min(ny - 1, Math.ceil((q[3] + r - y0) / GRID))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + i * GRID, y = y0 + j * GRID, cx = Math.max(q[0], Math.min(x, q[2])), cy = Math.max(q[1], Math.min(y, q[3]))
      if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) bad[j * nx + i] = 1
    }
  }
  return { x0, y0, nx, ny, bad, GRID }
}

function flood(R: ReturnType<typeof rasterize>, from: P): Uint8Array {
  const { x0, y0, nx, ny, bad, GRID } = R, seen = new Uint8Array(nx * ny)
  // 起點若被擋，找 300 mm 內最近的空格
  let s = -1, bd = 1e18
  const ci = Math.round((from[0] - x0) / GRID), cj = Math.round((from[1] - y0) / GRID)
  for (let dj = -6; dj <= 6; dj++) for (let di = -6; di <= 6; di++) {
    const i = ci + di, j = cj + dj
    if (i < 0 || j < 0 || i >= nx || j >= ny || bad[j * nx + i]) continue
    if (di * di + dj * dj < bd) { bd = di * di + dj * dj; s = j * nx + i }
  }
  if (s < 0) return seen
  const q = [s]; seen[s] = 1
  while (q.length) {
    const c = q.pop()!, i = c % nx, j = (c / nx) | 0
    if (i > 0 && !seen[c - 1] && !bad[c - 1]) { seen[c - 1] = 1; q.push(c - 1) }
    if (i < nx - 1 && !seen[c + 1] && !bad[c + 1]) { seen[c + 1] = 1; q.push(c + 1) }
    if (j > 0 && !seen[c - nx] && !bad[c - nx]) { seen[c - nx] = 1; q.push(c - nx) }
    if (j < ny - 1 && !seen[c + nx] && !bad[c + nx]) { seen[c + nx] = 1; q.push(c + nx) }
  }
  return seen
}

/** 大門內側 450 mm 的點（與出生點相反的一側）。 */
export function insideFrontDoor(g: GeneratedLayout): P {
  const bp = g.blueprint, d = bp.swingDoors.find((x) => x.entry) ?? bp.swingDoors[0]
  const r = d.rect, cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, horiz = r[2] - r[0] >= r[3] - r[1]
  const s = g.spawn.at, sgn = horiz ? (s[1] < cy ? 1 : -1) : s[0] < cx ? 1 : -1
  return horiz ? [cx, sgn > 0 ? r[3] + 450 : r[1] - 450] : [sgn > 0 ? r[2] + 450 : r[0] - 450, cy]
}

export type Target = { label: string; pts: P[] }
export function reachTargets(g: GeneratedLayout, items: GameFurniture[]): Target[] {
  const out: Target[] = []
  for (const r of g.blueprint.planRooms) {
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1]), pts: P[] = []
    for (let x = Math.min(...xs) + 100; x < Math.max(...xs); x += 100) for (let y = Math.min(...ys) + 100; y < Math.max(...ys); y += 100) if (pointInPoly([x, y], r.poly as P[])) pts.push([x, y])
    out.push({ label: `房間 ${r.name}`, pts })
  }
  for (const it of items) if (FIXTURE_SLOTS.has(it.slot)) {
    const room = g.blueprint.planRooms.find((r) => r.id === it.room)
    out.push({ label: `${it.name}(${room?.name ?? it.room}) 前方`, pts: standPoints(it) })
  }
  return out
}

/** 回傳走不到的目標名稱（空陣列＝全部走得到）。extra：額外碰撞盒（自動家具擺放中的候選）。 */
export function unreachable(g: GeneratedLayout, items: GameFurniture[], targets = reachTargets(g, items), extra: Box[] = []): string[] {
  const st = makeInteractables(g, items)
  for (const s of st) if (s.kind === "swing" || s.kind === "slide") s.open = true
  const nDoors = g.blueprint.swingDoors.length, start = insideFrontDoor(g)
  let left = targets
  for (let k = -1; k < nDoors && left.length; k++) {
    for (const s of st) if (s.kind === "swing") s.open = s.i !== k
    const R = rasterize(g, [...colliders(g, items, st), ...extra])
    const seen = flood(R, start)
    const ok = (p: P) => {
      const i = Math.round((p[0] - R.x0) / R.GRID), j = Math.round((p[1] - R.y0) / R.GRID)
      return i >= 0 && j >= 0 && i < R.nx && j < R.ny && seen[j * R.nx + i] === 1
    }
    left = left.filter((t) => !t.pts.some(ok))
  }
  return left.map((t) => t.label)
}

type Swing = GeneratedLayout["blueprint"]["swingDoors"][number]
/** 一扇平開門的 4 種開法（鉸鏈在左／右 × 開向兩側）；大門只換鉸鏈邊（維持往內開）。 */
export function swingVariants(d: Swing): Swing[] {
  const r = d.rect, horiz = r[2] - r[0] >= r[3] - r[1], out: Swing[] = []
  for (const side of [-1, 1]) for (const hEnd of [0, 1]) {
    const o: [number, number] = horiz ? [0, side] : [side, 0]
    if (d.entry && (o[0] !== d.o[0] || o[1] !== d.o[1])) continue
    const h: [number, number] = horiz ? [hEnd ? r[2] : r[0], side < 0 ? r[1] : r[3]] : [side < 0 ? r[0] : r[2], hEnd ? r[3] : r[1]]
    const c: [number, number] = horiz ? [hEnd ? -1 : 1, 0] : [0, hEnd ? -1 : 1]
    out.push({ ...d, h, c, o })
  }
  return out
}
const overlap = (a: readonly unknown[], b: readonly unknown[], m = 0) => (a[0] as number) < (b[2] as number) - m && (a[2] as number) > (b[0] as number) + m && (a[1] as number) < (b[3] as number) - m && (a[3] as number) > (b[1] as number) + m
/** 門扇掃過的外框（鉸鏈、關閉端、開啟端）。 */
export const sweepBox = (d: Swing): Box => {
  const L = d.len, xs = [d.h[0], d.h[0] + d.c[0] * L, d.h[0] + d.o[0] * L], ys = [d.h[1], d.h[1] + d.c[1] * L, d.h[1] + d.o[1] * L]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
const SOFT_T = new Set(["rug", "tv"])
/** 依遊戲可達性挑每扇門的開法（貪婪、最多兩輪）：新的掃掠區不可壓到牆或實體家具。會改 g.blueprint.swingDoors。回傳是否有改。 */
export function fixDoorSwings(g: GeneratedLayout, items: GameFurniture[]): boolean {
  const bp = g.blueprint
  const score = () => unreachable(g, items).length * 10 + entryConflicts(g)
  let best = score(), changed = false
  for (let pass = 0; pass < 2 && best > 0; pass++) {
    for (let i = 0; i < bp.swingDoors.length && best > 0; i++) {
      const cur = bp.swingDoors[i]
      for (const v of swingVariants(cur)) {
        if (v.h[0] === cur.h[0] && v.h[1] === cur.h[1] && v.o[0] === cur.o[0] && v.o[1] === cur.o[1]) continue
        const sw = sweepBox(v)
        if (bp.walls.some((w) => overlap(sw, w, 25))) continue
        if (items.some((it) => !SOFT_T.has(it.type) && overlap(sw, boxOfIt(it), 3))) continue
        bp.swingDoors[i] = v
        const u = score()
        if (u < best) { best = u; changed = true; break }
        bp.swingDoors[i] = cur
      }
    }
  }
  return changed
}
/** 大門打開（90°）後門片是否壓到其他門的掃掠區或門洞前 0.3 m（例：大門門片擋住衛浴門）。回傳衝突數。 */
export function entryConflicts(g: GeneratedLayout): number {
  const ds = g.blueprint.swingDoors, e = ds.find((d) => d.entry)
  if (!e) return 0
  const leaf = leafBox(e, true)
  return ds.filter((d) => d !== e && (overlap(leaf, sweepBox(d), 5) || overlap(leaf, [d.rect[0] - 300, d.rect[1] - 300, d.rect[2] + 300, d.rect[3] + 300], 5))).length
}
const boxOfIt = (it: GameFurniture): Box => {
  const sw = it.rot % 180 === 0 ? it.w : it.d, sd = it.rot % 180 === 0 ? it.d : it.w
  return [it.cx - sw / 2, it.cy - sd / 2, it.cx + sw / 2, it.cy + sd / 2]
}

/** 依自動家具後的遊戲可達性調整門的開法（鉸鏈邊／開向）；會改 g。 */
export function polishDoors(g: GeneratedLayout): GeneratedLayout {
  const items = autoFurnish(g).items
  if (unreachable(g, items).length || entryConflicts(g)) fixDoorSwings(g, items)
  return g
}

/** 需要前方站位的家具型別（擺放時用）。 */
export const ACCESS_TYPES = new Set(["washer", "toilet", "vanity", "shower", "bathtub", "bed", "wardrobe", "fridge", "stove"])
type ItemLike = { cx: number; cy: number; w: number; d: number; rot: number; type: string }
const NOCOL = new Set(["rug", "tv", "chair"])
/**
 * 給自動家具用的快速檢查器（同一碰撞模型、門全開、100 mm 格點，比驗證用的 50 mm 保守）：
 * 回傳 ok(items)＝原本走得到的房間仍走得到，且每件需要站位的家具前方都站得到。
 */
export function makeFurnishChecker(g: GeneratedLayout) {
  const st = makeInteractables(g, [])
  for (const s of st) if (s.kind === "swing" || s.kind === "slide") s.open = true
  const base = rasterize(g, colliders(g, [], st), PLAYER_R, 100), start = insideFrontDoor(g)
  const roomPts = g.blueprint.planRooms.map((r) => {
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1]), pts: P[] = []
    for (let x = Math.min(...xs) + 100; x < Math.max(...xs); x += 200) for (let y = Math.min(...ys) + 100; y < Math.max(...ys); y += 200) if (pointInPoly([x, y], r.poly as P[])) pts.push([x, y])
    return pts
  })
  const run = (items: ItemLike[]) => {
    const bad = base.bad.slice(), R = { ...base, bad }, r = PLAYER_R, G = base.GRID
    for (const it of items) {
      if (NOCOL.has(it.type)) continue
      const sw = it.rot % 180 === 0 ? it.w : it.d, sd = it.rot % 180 === 0 ? it.d : it.w, q = [it.cx - sw / 2, it.cy - sd / 2, it.cx + sw / 2, it.cy + sd / 2]
      const i0 = Math.max(0, Math.floor((q[0] - r - R.x0) / G)), i1 = Math.min(R.nx - 1, Math.ceil((q[2] + r - R.x0) / G))
      const j0 = Math.max(0, Math.floor((q[1] - r - R.y0) / G)), j1 = Math.min(R.ny - 1, Math.ceil((q[3] + r - R.y0) / G))
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = R.x0 + i * G, y = R.y0 + j * G, cx = Math.max(q[0], Math.min(x, q[2])), cy = Math.max(q[1], Math.min(y, q[3]))
        if ((x - cx) ** 2 + (y - cy) ** 2 < r * r) bad[j * R.nx + i] = 1
      }
    }
    const seen = flood(R, start)
    return (p: P) => { const i = Math.round((p[0] - R.x0) / G), j = Math.round((p[1] - R.y0) / G); return i >= 0 && j >= 0 && i < R.nx && j < R.ny && seen[j * R.nx + i] === 1 }
  }
  const at0 = run([]), baseRooms = roomPts.map((pts) => pts.some(at0))
  return (items: ItemLike[]) => {
    const ok = run(items)
    if (roomPts.some((pts, k) => baseRooms[k] && !pts.some(ok))) return false
    return items.every((it) => !ACCESS_TYPES.has(it.type) || standPoints(it).some(ok))
  }
}
