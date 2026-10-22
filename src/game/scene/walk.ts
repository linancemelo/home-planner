/** 走動邏輯（不依賴 three，可在 Node 測）：碰撞盒、可開關物件、圓形角色移動。單位 mm、平面 y 向下。 */
import type { GeneratedLayout } from "../layout/types.ts"
import { boxOf, type GameFurniture } from "../furnish/autoFurnish.ts"
import { pointInPoly } from "../layout/validateLayout.ts"

export type Box = [number, number, number, number]
export const H = { ceiling: 2800, door: 2100, sill: 900, winTop: 2100 } // 淨高／門高／窗台／窗頂（mm）
export const PLAYER_R = 200
const LEAF = 40 // 門片厚

export type Interactable =
  | { kind: "swing"; i: number; name: string; at: [number, number]; open: boolean }
  | { kind: "slide"; i: number; name: string; at: [number, number]; open: boolean; rect: Box }
  | { kind: "window"; i: number; name: string; at: [number, number]; open: boolean; rect: Box }
  | { kind: "fridge"; id: string; name: string; at: [number, number]; open: boolean }

const NO_COLLIDE = new Set(["rug", "tv", "chair"])

export function makeInteractables(g: GeneratedLayout, items: GameFurniture[]): Interactable[] {
  const bp = g.blueprint, c = (r: number[]): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]
  return [
    ...bp.swingDoors.map((d, i) => ({ kind: "swing" as const, i, name: d.name, at: c(d.rect), open: false })),
    ...bp.slidingDoors.map((s, i) => ({ kind: "slide" as const, i, name: "落地窗", at: c(s.rect), open: false, rect: [s.rect[0], s.rect[1], s.rect[2], s.rect[3]] as Box })),
    ...bp.windowOpenings.map((w, i) => ({ kind: "window" as const, i, name: "窗戶", at: c(w), open: false, rect: [w[0], w[1], w[2], w[3]] as Box })),
    ...items.filter((it) => it.type === "fridge").map((it) => {
      const n = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0]
      return { kind: "fridge" as const, id: it.id, name: "冰箱", at: [it.cx + n[0] * it.d / 2, it.cy + n[1] * it.d / 2] as [number, number], open: false }
    }),
  ]
}

/** 門片外框：關＝沿 c、開＝沿 o（都和軸對齊）。 */
export function leafBox(d: GeneratedLayout["blueprint"]["swingDoors"][number], open: boolean): Box {
  const v = open ? d.o : d.c, [hx, hy] = d.h, ex = hx + v[0] * d.len, ey = hy + v[1] * d.len
  const t = LEAF / 2
  return [Math.min(hx, ex) - (v[0] === 0 ? t : 0), Math.min(hy, ey) - (v[1] === 0 ? t : 0), Math.max(hx, ex) + (v[0] === 0 ? t : 0), Math.max(hy, ey) + (v[1] === 0 ? t : 0)]
}
/** 落地窗兩片：關＝蓋滿；開＝都疊在一半。 */
export function slidePanels(s: { rect: number[]; v: boolean }, open: boolean): Box[] {
  const r = s.rect, horiz = r[2] - r[0] >= r[3] - r[1], L = horiz ? r[2] - r[0] : r[3] - r[1]
  const at = (u0: number, u1: number): Box => (horiz ? [r[0] + u0, r[1], r[0] + u1, r[3]] : [r[0], r[1] + u0, r[2], r[1] + u1])
  return open ? [at(0, L / 2), at(0, L / 2)] : [at(0, L / 2 + 20), at(L / 2 - 20, L)]
}

export function colliders(g: GeneratedLayout, items: GameFurniture[], st: Interactable[]): Box[] {
  const bp = g.blueprint, out: Box[] = []
  for (const w of bp.walls) out.push([w[0], w[1], w[2], w[3]])
  for (const w of bp.windowOpenings) out.push([w[0], w[1], w[2], w[3]])
  for (const s of st) {
    if (s.kind === "swing") out.push(leafBox(bp.swingDoors[s.i], s.open))
    if (s.kind === "slide") out.push(...slidePanels(bp.slidingDoors[s.i], s.open))
  }
  for (const it of items) if (!NO_COLLIDE.has(it.type)) out.push(boxOf(it.cx, it.cy, it.w, it.d, it.rot))
  // 打開的冰箱門也有碰撞
  for (const s of st) if (s.kind === "fridge" && s.open) { const it = items.find((i) => i.id === s.id); if (it) out.push(fridgeDoorBox(it)) }
  return out
}
/** 冰箱門開 90°：以正面一側為軸，門片朝前方伸出 w 長（與 buildScene 的轉軸一致）。 */
export function fridgeDoorBox(it: { cx: number; cy: number; w: number; d: number; rot: number }): Box {
  const n = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0], t = [-n[1], n[0]]
  const hx = it.cx + n[0] * (it.d / 2) - t[0] * (it.w / 2), hy = it.cy + n[1] * (it.d / 2) - t[1] * (it.w / 2)
  const ex = hx + n[0] * it.w, ey = hy + n[1] * it.w, th = 25
  return [Math.min(hx, ex) - (n[0] === 0 ? th : 0), Math.min(hy, ey) - (n[1] === 0 ? th : 0), Math.max(hx, ex) + (n[0] === 0 ? th : 0), Math.max(hy, ey) + (n[1] === 0 ? th : 0)]
}

const hits = (x: number, y: number, r: number, b: Box) => {
  const nx = Math.max(b[0], Math.min(x, b[2])), ny = Math.max(b[1], Math.min(y, b[3]))
  return (x - nx) ** 2 + (y - ny) ** 2 < r * r
}
export const blocked = (x: number, y: number, boxes: Box[], r = PLAYER_R) => boxes.some((b) => hits(x, y, r, b))

/** 依軸分開滑動，撞牆就沿牆滑。 */
export function move(p: [number, number], dx: number, dy: number, boxes: Box[], r = PLAYER_R): [number, number] {
  let [x, y] = p
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (r / 2)))
  for (let i = 0; i < steps; i++) {
    if (!blocked(x + dx / steps, y, boxes, r)) x += dx / steps
    if (!blocked(x, y + dy / steps, boxes, r)) y += dy / steps
  }
  return [x, y]
}

/** 線段 a→b 是否穿過盒子（slab 法）。 */
function segHits(a: [number, number], b: [number, number], q: Box): boolean {
  let t0 = 0, t1 = 1
  for (const k of [0, 1] as const) {
    const d = b[k] - a[k], lo = q[k], hi = q[k + 2]
    if (Math.abs(d) < 1e-9) { if (a[k] <= lo || a[k] >= hi) return false; continue }
    let u = (lo - a[k]) / d, v = (hi - a[k]) / d
    if (u > v) [u, v] = [v, u]
    t0 = Math.max(t0, u); t1 = Math.min(t1, v)
    if (t0 >= t1) return false
  }
  return true
}
/**
 * 可以操作的最近物件：1.6 m 內（落地窗／窗量到開口上最近點，其餘量到中心）、大致面向它（夾角 ≤ 70°，貼很近時不限）、而且視線沒被牆／窗台／其他關著的門片擋住。
 * dir＝玩家面向（平面座標單位向量）；不給 g 時只看距離（舊行為，給測試用）。
 */
export function nearest(st: Interactable[], p: [number, number], max = 1600, g?: GeneratedLayout, dir?: [number, number]): Interactable | null {
  let best: Interactable | null = null, bd = max
  const bp = g?.blueprint
  for (const s of st) {
    // 落地窗／窗：距離量到開口上最近的一點（長拉門不再只認中心）
    const at: [number, number] = s.kind === "slide" || s.kind === "window" ? [Math.max(s.rect[0], Math.min(p[0], s.rect[2])), Math.max(s.rect[1], Math.min(p[1], s.rect[3]))] : s.at
    const dx = at[0] - p[0], dy = at[1] - p[1], d = Math.hypot(dx, dy)
    if (d >= bd) continue
    if (dir && d > 350 && (dx * dir[0] + dy * dir[1]) / d < Math.cos((70 * Math.PI) / 180)) continue
    if (bp) {
      // 線段終點退 60 mm，避免碰到門洞／窗洞兩側的牆角
      const e: [number, number] = d > 60 ? [at[0] - (dx / d) * 60, at[1] - (dy / d) * 60] : p
      const block: Box[] = [...bp.walls.map((w) => [w[0], w[1], w[2], w[3]] as Box), ...bp.windowOpenings.filter((_, i) => !(s.kind === "window" && s.i === i)).map((w) => [w[0], w[1], w[2], w[3]] as Box)]
      for (const o of st) if (o.kind === "swing" && !o.open && !(s.kind === "swing" && s.i === o.i)) block.push(leafBox(bp.swingDoors[o.i], false))
      if (block.some((q) => segHits(p, e, q))) continue
    }
    bd = d; best = s
  }
  return best
}

/** 在哪個房間（給 HUD 顯示）。 */
export function roomAt(g: GeneratedLayout, p: [number, number]): string | null {
  return g.blueprint.planRooms.find((r) => pointInPoly(p, r.poly as [number, number][]))?.name ?? null
}

/**
 * 開關時門片（或冰箱門）會壓到人：沿「離物件遠」的方向用 move() 一步步走（碰撞照算，不穿牆），最多 1.2 m；
 * 途中離開原房間就放棄。走到不再被新門片壓到的位置就回傳，否則 null（呼叫端不開並提示）。
 */
export function stepBack(g: GeneratedLayout, p: [number, number], at: [number, number], before: Box[], after: Box[]): [number, number] | null {
  const ax = p[0] - at[0], ay = p[1] - at[1], L = Math.hypot(ax, ay) || 1, room0 = roomAt(g, p)
  let q = p
  for (let d = 0; d < 1200; d += 50) {
    const nq = move(q, (ax / L) * 50, (ay / L) * 50, before)
    if (nq[0] === q[0] && nq[1] === q[1]) return null // 卡住了
    q = nq
    if (roomAt(g, q) !== room0) return null
    if (!blocked(q[0], q[1], after)) return q
  }
  return null
}
