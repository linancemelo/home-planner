/**
 * 自動配家具：依房型把家具靠牆／自由擺放，避開門扇、門前通道、落地窗前、窗下高櫃，留走道淨空。
 * 適用任意直角多邊形房間（範本與程序化戶型皆可）。可用 overrides 指定某槽位的款式（替換家具）。
 */
import type { SchemeFurniture } from "../../plan/state/schemeStore.ts"
import type { GeneratedLayout } from "../layout/types.ts"
import { floodGrid, pointInPoly } from "../layout/validateLayout.ts"
import { makeFurnishChecker } from "../scene/reach.ts"
import { VARIANTS, type SlotId, type Variant } from "./variants.ts"

type P = [number, number]
export type Box = [number, number, number, number]
export type GameFurniture = SchemeFurniture & { slot: SlotId; slotKey: string; variant: string; room: string }
export type Furnished = { items: GameFurniture[]; missing: string[] }

const TALL = new Set(["wardrobe", "fridge", "bookshelf", "shower"])
const r10 = (v: number) => Math.round(v)
const hit = (a: Box, b: Box, m = 0) => a[0] < b[2] + m && a[2] > b[0] - m && a[1] < b[3] + m && a[3] > b[1] - m
const grow = (b: Box, m: number): Box => [b[0] - m, b[1] - m, b[2] + m, b[3] + m]

/** 依旋轉算外框；rot 0＝背靠北（y 小），90＝背靠東，180＝背靠南，270＝背靠西。 */
export function boxOf(cx: number, cy: number, w: number, d: number, rot: number): Box {
  const sw = rot % 180 === 0 ? w : d, sd = rot % 180 === 0 ? d : w
  return [cx - sw / 2, cy - sd / 2, cx + sw / 2, cy + sd / 2]
}
/** 牆的內法線 n → 背靠牆的旋轉角。 */
const rotFor = (n: P) => (n[1] === 1 ? 0 : n[0] === -1 ? 90 : n[1] === -1 ? 180 : 270)

type Edge = { a: P; b: P; n: P; horiz: boolean; c: number; lo: number; hi: number }
function edgesOf(poly: P[]): Edge[] {
  const out: Edge[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], horiz = Math.abs(a[1] - b[1]) < 1
    if (!horiz && Math.abs(a[0] - b[0]) > 1) continue
    const m: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const n: P = horiz ? (pointInPoly([m[0], m[1] + 60], poly) ? [0, 1] : [0, -1]) : pointInPoly([m[0] + 60, m[1]], poly) ? [1, 0] : [-1, 0]
    out.push({ a, b, n, horiz, c: horiz ? a[1] : a[0], lo: Math.min(horiz ? a[0] : a[1], horiz ? b[0] : b[1]), hi: Math.max(horiz ? a[0] : a[1], horiz ? b[0] : b[1]) })
  }
  return out
}

export const MOVABLE = new Set(["rug", "tv", "chair"]) // 走動檢查時不算障礙
const NEEDS_ACCESS = new Set(["fridge", "toilet", "wardrobe", "bed", "stove"])
/** 人要站得到的點（前方 0.3–0.5 m；床另含兩側），任一可達即可。 */
export function accessPoints(it: { cx: number; cy: number; w: number; d: number; rot: number; type: string }): P[] | null {
  if (!NEEDS_ACCESS.has(it.type)) return null
  const n: P = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0]
  const pts: P[] = [300, 400, 500].map((d) => [it.cx + n[0] * (it.d / 2 + d), it.cy + n[1] * (it.d / 2 + d)])
  if (it.type === "bed") {
    const side: P = it.rot % 180 === 0 ? [1, 0] : [0, 1]
    for (const s of [-1, 1]) for (const d of [300, 400, 500]) pts.push([it.cx + side[0] * s * (it.w / 2 + d), it.cy + side[1] * s * (it.w / 2 + d)])
  }
  return pts
}

/** 家具前方淨空區（深 clr，寬至少 minW，置中）。 */
function clearBox(b: Box, e: { horiz: boolean; n: P }, clr: number, minW = 0): Box {
  const ex = Math.max(0, (minW - (e.horiz ? b[2] - b[0] : b[3] - b[1])) / 2)
  return e.horiz ? (e.n[1] > 0 ? [b[0] - ex, b[3], b[2] + ex, b[3] + clr] : [b[0] - ex, b[1] - clr, b[2] + ex, b[1]]) : e.n[0] > 0 ? [b[2], b[1] - ex, b[2] + clr, b[3] + ex] : [b[0] - clr, b[1] - ex, b[0], b[3] + ex]
}

export function autoFurnish(g: GeneratedLayout, overrides: Record<string, string> = {}, seed = g.config.seed): Furnished {
  const bp = g.blueprint
  const walls = bp.walls.map((w) => [w[0], w[1], w[2], w[3]] as Box)
  const wins = bp.windowOpenings.map((w) => [w[0], w[1], w[2], w[3]] as Box)
  const items: GameFurniture[] = [], missing: string[] = []
  const reserved: Box[] = [] // 家具＋其前方淨空
  const keepout: Box[] = []
  // 門扇擺動區＋門兩側 0.7 m 通道；落地窗前後 0.9 m；大門內側 1.1 m
  for (const d of bp.swingDoors) {
    const L = d.len, [hx, hy] = d.h
    const xs = [hx, hx + d.c[0] * L, hx + d.o[0] * L], ys = [hy, hy + d.c[1] * L, hy + d.o[1] * L]
    keepout.push(grow([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], 50))
    const r = d.rect, horiz = r[2] - r[0] > r[3] - r[1], dep = d.entry ? 1100 : 700
    keepout.push(horiz ? [r[0] - 50, r[1] - dep, r[2] + 50, r[3] + dep] : [r[0] - dep, r[1] - 50, r[2] + dep, r[3] + 50])
  }
  for (const s of bp.slidingDoors) {
    const r = s.rect, horiz = r[2] - r[0] > r[3] - r[1]
    keepout.push(horiz ? [r[0], r[1] - 900, r[2], r[3] + 900] : [r[0] - 900, r[1], r[2] + 900, r[3]])
  }
  let rnd = (seed * 2654435761) >>> 0
  const rand = () => ((rnd = (rnd * 1664525 + 1013904223) >>> 0) / 2 ** 32)

  // 可達性用遊戲碰撞模型（scene/reach.ts，門全開、玩家 r=0.2 m）：加上 extra 後原本走得到的房間仍走得到、所有需要站位的家具前方站得到
  const check = makeFurnishChecker(g)
  const accessible = (extra: { cx: number; cy: number; w: number; d: number; rot: number; type: string }[]) => check([...items, ...extra])
  const pick = (key: string, slot: SlotId, order?: string[]): Variant[] => {
    const vs = VARIANTS[slot], want = overrides[key]
    const ordered = order ? order.map((id) => vs.find((v) => v.id === id)!).filter(Boolean) : vs
    return want ? [vs.find((v) => v.id === want) ?? ordered[0], ...ordered.filter((v) => v.id !== want)] : ordered
  }
  const add = (room: string, slot: SlotId, key: string, v: Variant, cx: number, cy: number, rot: number, clear: Box | null) => {
    const it: GameFurniture = { id: `g-${key.replace(/[:]/g, "-")}`, type: v.type, name: v.name, cx: r10(cx), cy: r10(cy), w: v.w, d: v.d, rot, color: v.color, slot, slotKey: key, variant: v.id, room }
    items.push(it)
    reserved.push(boxOf(it.cx, it.cy, v.w, v.d, rot))
    if (clear) reserved.push(clear)
    return it
  }
  const insidePoly = (b: Box, poly: P[]) => [[b[0] + 5, b[1] + 5], [b[2] - 5, b[1] + 5], [b[2] - 5, b[3] - 5], [b[0] + 5, b[3] - 5], [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]].every((p) => pointInPoly(p as P, poly))
  const freeBox = (b: Box, poly: P[], ignoreReserved = false) =>
    insidePoly(b, poly) && !walls.some((w) => hit(b, w, -2)) && !keepout.some((k) => hit(b, k, -2)) && (ignoreReserved || !reserved.some((r) => hit(b, r, -2)))

  /** 靠牆候選：回傳所有合法位置（含前方淨空 clr mm）。 */
  const wallSpots = (poly: P[], v: Variant, clr: number, tall: boolean, minW = 0) => {
    const out: { cx: number; cy: number; rot: number; e: Edge; u: number }[] = []
    for (const e of edgesOf(poly)) {
      // 牆面在多邊形邊的哪裡（範本多邊形在牆中心線、CAD 在牆面）：找背後的牆
      const mid = (e.lo + e.hi) / 2
      for (let u = e.lo + v.w / 2; u <= e.hi - v.w / 2 + 1; u += 100) {
        const back: P[] = [-0.45, 0, 0.45].map((f) => (e.horiz ? [u + f * v.w, e.c - e.n[1] * 20] : [e.c - e.n[0] * 20, u + f * v.w]) as P)
        // 背後要是牆（或窗：只允許矮家具）
        const behind = (p: P) => walls.find((w) => p[0] >= w[0] - 25 && p[0] <= w[2] + 25 && p[1] >= w[1] - 25 && p[1] <= w[3] + 25)
        const onWin = back.some((p) => wins.some((w) => p[0] >= w[0] - 25 && p[0] <= w[2] + 25 && p[1] >= w[1] - 25 && p[1] <= w[3] + 25))
        if (tall && onWin) continue
        if (!back.every((p) => behind(p) || wins.some((w) => p[0] >= w[0] - 25 && p[0] <= w[2] + 25 && p[1] >= w[1] - 25 && p[1] <= w[3] + 25))) continue
        // 牆面位置：取背後牆片的內面
        const wb = behind(back[1]) ?? walls.find((w) => hit([back[1][0], back[1][1], back[1][0], back[1][1]], w, 25))
        let face = e.c
        if (wb) face = e.horiz ? (e.n[1] > 0 ? Math.max(e.c, wb[3]) : Math.min(e.c, wb[1])) : e.n[0] > 0 ? Math.max(e.c, wb[2]) : Math.min(e.c, wb[0])
        const off = face + (e.horiz ? e.n[1] : e.n[0]) * (v.d / 2 + 10)
        const cx = e.horiz ? u : off, cy = e.horiz ? off : u, rot = rotFor(e.n)
        const b = boxOf(cx, cy, v.w, v.d, rot)
        if (!freeBox(b, poly)) continue
        const cl = clearBox(b, e, clr, minW)
        if (clr && !(insidePoly(cl, poly) && !walls.some((w) => hit(cl, w, -2)) && !reserved.some((r) => hit(cl, r, -2)))) continue
        out.push({ cx, cy, rot, e, u: u - mid })
      }
    }
    return out
  }
  const placeWall = (room: string, poly: P[], slot: SlotId, key: string, clr: number, score: (s: { cx: number; cy: number; rot: number; e: Edge; u: number }, v: Variant) => number, order?: string[], minW = 0) => {
    for (const v of pick(key, slot, order)) {
      const spots = wallSpots(poly, v, clr, TALL.has(v.type), minW)
      if (!spots.length) continue
      spots.sort((a, b) => score(b, v) - score(a, v))
      const s = spots.slice(0, 15).find((s) => accessible([{ cx: s.cx, cy: s.cy, w: v.w, d: v.d, rot: s.rot, type: v.type }]))
      if (!s) continue
      const b = boxOf(s.cx, s.cy, v.w, v.d, s.rot)
      const cl = clearBox(b, s.e, clr, minW)
      return { it: add(room, slot, key, v, s.cx, s.cy, s.rot, clr ? cl : null), spot: s, v }
    }
    missing.push(key)
    return null
  }
  const doorsOf = (poly: P[]) => bp.swingDoors.filter((d) => { const r = d.rect, c: P = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]; return [[c[0] + 400, c[1]], [c[0] - 400, c[1]], [c[0], c[1] + 400], [c[0], c[1] - 400]].some((p) => pointInPoly(p as P, poly)) })
  const dist = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1])
  const winCount = (s: { cx: number; cy: number }) => wins.filter((w) => dist([(w[0] + w[2]) / 2, (w[1] + w[3]) / 2], [s.cx, s.cy]) < 1500).length

  for (const room of bp.planRooms) {
    const k = g.kinds[room.id], poly = room.poly as P[], id = room.id
    const dr = doorsOf(poly).map((d) => [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2] as P)
    const farFromDoor = (s: { cx: number; cy: number }) => (dr.length ? Math.min(...dr.map((p) => dist(p, [s.cx, s.cy]))) : 0)
    function doKitchen() {
      // 廚具一排：冰箱＋流理台(含水槽)＋瓦斯爐；放不下就拆開放
      const entry = bp.swingDoors.find((d) => d.entry)
      const ec: P = entry ? [(entry.rect[0] + entry.rect[2]) / 2, (entry.rect[1] + entry.rect[3]) / 2] : [0, 0]
      const slide = bp.slidingDoors[0]?.rect
      const sc: P = slide ? [(slide[0] + slide[2]) / 2, (slide[1] + slide[3]) / 2] : ec
      const kScore = (s: { cx: number; cy: number }) => (k === "kitchen" ? 0 : dist([s.cx, s.cy], sc) / 1000 - dist([s.cx, s.cy], ec) / 3000)
      const fr = placeWall(id, poly, "fridge", `${id}:fridge`, 800, kScore)
      const near = (s: { cx: number; cy: number }) => (fr ? -dist([s.cx, s.cy], [fr.it.cx, fr.it.cy]) / 1000 : 0)
      // 流理台＋瓦斯爐連成一排（先試整排，放不下再分開）
      let run = false
      for (const cv of pick(`${id}:counter`, "counter")) {
        const sv = pick(`${id}:stove`, "stove")[0], comb: Variant = { ...cv, w: cv.w + sv.w }
        const spots = wallSpots(poly, comb, 900, false)
        if (!spots.length) continue
        spots.sort((a, b) => near(b) - near(a))
        const s = spots.slice(0, 15).find((s) => accessible([{ cx: s.cx, cy: s.cy, w: comb.w, d: comb.d, rot: s.rot, type: "stove" }]))
        if (!s) continue
        const ax: P = s.e.horiz ? [1, 0] : [0, 1]
        add(id, "counter", `${id}:counter`, cv, s.cx - ax[0] * sv.w / 2, s.cy - ax[1] * sv.w / 2, s.rot, null)
        const b = boxOf(s.cx, s.cy, comb.w, comb.d, s.rot), clr = 900, e = s.e
        add(id, "stove", `${id}:stove`, sv, s.cx + ax[0] * cv.w / 2, s.cy + ax[1] * cv.w / 2, s.rot, clearBox(b, e, clr))
        run = true
        break
      }
      if (!run) {
        placeWall(id, poly, "stove", `${id}:stove`, 750, near)
        placeWall(id, poly, "counter", `${id}:counter`, 750, near)
      }
    }
    function doLiving() {
      const entry = bp.swingDoors.find((d) => d.entry)
      const ec: P = entry ? [(entry.rect[0] + entry.rect[2]) / 2, (entry.rect[1] + entry.rect[3]) / 2] : [0, 0]
      placeWall(id, poly, "shoecab", `${id}:shoecab`, 600, (s) => -dist([s.cx, s.cy], ec) / 1000)
      const areas = g.livingAreas, lr = areas.find((a) => a.name === "客廳區")?.rect, dr_ = areas.find((a) => a.name === "餐廳區")?.rect
      const inR = (r: number[] | undefined, s: { cx: number; cy: number }) => (r && s.cx >= r[0] && s.cx <= r[2] && s.cy >= r[1] && s.cy <= r[3] ? 1 : 0)
      // 沙發與電視櫃面對面
      let placed = false
      for (const sv of pick(`${id}:sofa`, "sofa", ["sofa3", "sofa2", "sofaL", "sofa1"])) {
        if (placed) break
        const sofaSpots = wallSpots(poly, sv, 0, false)
        const pairs: { s: (typeof sofaSpots)[0]; t: (typeof sofaSpots)[0]; tv: Variant; score: number }[] = []
        for (const tv of pick(`${id}:tvstand`, "tvstand", ["tv240", "tv150"])) {
          const tvSpots = wallSpots(poly, tv, 0, false)
          for (const s of sofaSpots) for (const t of tvSpots) {
            if (t.e.horiz !== s.e.horiz || t.e.n[0] !== -s.e.n[0] || t.e.n[1] !== -s.e.n[1]) continue
            const gap = s.e.horiz ? Math.abs(t.cy - s.cy) : Math.abs(t.cx - s.cx), off = s.e.horiz ? Math.abs(t.cx - s.cx) : Math.abs(t.cy - s.cy)
            if (gap < 2000 || gap > 5500 || off > 700) continue
            const sb = boxOf(s.cx, s.cy, sv.w, sv.d, s.rot), tb = boxOf(t.cx, t.cy, tv.w, tv.d, t.rot)
            if (hit(sb, tb)) continue
            const score = -off / 400 - Math.abs(gap - 3000) / 1000 + inR(lr, s) + (tv.id === "tv240" ? 0.3 : 0)
            pairs.push({ s, t, tv, score })
          }
        }
        pairs.sort((a, b) => b.score - a.score)
        const best = pairs.slice(0, 15).find((p) => accessible([{ cx: p.s.cx, cy: p.s.cy, w: sv.w, d: sv.d, rot: p.s.rot, type: sv.type }, { cx: p.t.cx, cy: p.t.cy, w: p.tv.w, d: p.tv.d, rot: p.t.rot, type: p.tv.type }]))
        if (!best) continue
        const sofa = add(id, "sofa", `${id}:sofa`, sv, best.s.cx, best.s.cy, best.s.rot, null)
        const st = add(id, "tvstand", `${id}:tvstand`, best.tv, best.t.cx, best.t.cy, best.t.rot, null)
        const tvv = pick(`${id}:tv`, "tv")[0], n = best.t.e.n
        items.push({ id: `g-${id}-tv`, type: tvv.type, name: tvv.name, cx: r10(st.cx - n[0] * (best.tv.d / 2 - tvv.d / 2 - 20)), cy: r10(st.cy - n[1] * (best.tv.d / 2 - tvv.d / 2 - 20)), w: tvv.w, d: tvv.d, rot: st.rot, color: tvv.color, slot: "tv", slotKey: `${id}:tv`, variant: tvv.id, room: id })
        // 茶几在沙發前 0.45 m、地毯在中間
        const sn = best.s.e.n, sb = boxOf(sofa.cx, sofa.cy, sv.w, sv.d, sofa.rot)
        const front = sv.type === "cornersofa" ? 1000 : sv.d / 2
        for (const cv of pick(`${id}:coffeetable`, "coffeetable")) {
          const cx = sofa.cx + sn[0] * (front + 450 + cv.d / 2), cy = sofa.cy + sn[1] * (front + 450 + cv.d / 2)
          const cb = boxOf(cx, cy, cv.w, cv.d, sofa.rot)
          if (freeBox(cb, poly)) { add(id, "coffeetable", `${id}:coffeetable`, cv, cx, cy, sofa.rot, null); break }
        }
        const rg = VARIANTS.rug[0], rcx = (sofa.cx + st.cx) / 2, rcy = (sofa.cy + st.cy) / 2
        if (insidePoly(boxOf(rcx, rcy, rg.w, rg.d, sofa.rot), poly)) items.push({ id: `g-${id}-rug`, type: rg.type, name: rg.name, cx: r10(rcx), cy: r10(rcy), w: rg.w, d: rg.d, rot: sofa.rot, color: rg.color, slot: "rug", slotKey: `${id}:rug`, variant: rg.id, room: id })
        // 沙發與電視之間保留（茶几以外）
        reserved.push(sb)
        reserved.push([Math.min(sb[0], st.cx - 10), Math.min(sb[1], st.cy - 10), Math.max(sb[2], st.cx + 10), Math.max(sb[3], st.cy + 10)])
        placed = true
      }
      if (!placed) {
        missing.push(`${id}:sofa+tv`)
        let sofa = placeWall(id, poly, "sofa", `${id}:sofa`, 1300, (s) => inR(lr, s), ["sofa2", "sofa3"])
        if (!sofa) sofa = placeWall(id, poly, "sofa", `${id}:sofa`, 700, (s) => inR(lr, s), ["sofa2", "sofa1"])
        if (sofa) for (let i = missing.length - 1; i >= 0; i--) if (missing[i] === `${id}:sofa`) missing.splice(i, 1)
      }
      // 餐桌：在客餐廳裡找空位（含椅子與 0.6 m 走道）
      let dined = false
      for (const dv of pick(`${id}:dining`, "dining", ["dt140", "dtround", "dt180"])) {
        if (dined) break
        const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
        const cands: { cx: number; cy: number; rot: number; sc: number }[] = []
        for (const rot of [0, 90]) for (let x = Math.min(...xs); x <= Math.max(...xs); x += 100) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 100) {
          const tb = boxOf(x, y, dv.w, dv.d, rot), zone = grow(tb, 550 + 300)
          if (!insidePoly(grow(tb, 550), poly) || !freeBox(grow(tb, 550), poly) || walls.some((w) => hit(zone, w, -2)) || reserved.some((r) => hit(zone, r, -2))) continue
          const fr = items.find((i) => i.type === "fridge")
          cands.push({ cx: x, cy: y, rot, sc: inR(dr_, { cx: x, cy: y }) * 3 - (fr ? dist([x, y], [fr.cx, fr.cy]) / 1000 : 0) + rand() * 0.1 })
        }
        if (!cands.length) continue
        cands.sort((a, b) => b.sc - a.sc)
        const c = cands.slice(0, 15).find((c) => accessible([{ cx: c.cx, cy: c.cy, w: dv.w + 1000, d: dv.d + 1000, rot: c.rot, type: dv.type }]))
        if (!c) continue
        const t = add(id, "dining", `${id}:dining`, dv, c.cx, c.cy, c.rot, grow(boxOf(c.cx, c.cy, dv.w, dv.d, c.rot), 550))
        const ch = VARIANTS.diningchair[0], tb = boxOf(t.cx, t.cy, dv.w, dv.d, c.rot)
        const n = dv.type === "roundtable" ? 1 : dv.w >= 1800 ? 3 : 2
        for (let i = 0; i < n; i++) {
          const f = (i + 0.5) / n
          if (c.rot === 0) {
            items.push({ id: `g-${id}-dc${i}a`, type: "chair", name: ch.name, cx: r10(tb[0] + (tb[2] - tb[0]) * f), cy: r10(tb[1] - 300), w: ch.w, d: ch.d, rot: 180, color: ch.color, slot: "diningchair", slotKey: `${id}:diningchair`, variant: ch.id, room: id })
            items.push({ id: `g-${id}-dc${i}b`, type: "chair", name: ch.name, cx: r10(tb[0] + (tb[2] - tb[0]) * f), cy: r10(tb[3] + 300), w: ch.w, d: ch.d, rot: 0, color: ch.color, slot: "diningchair", slotKey: `${id}:diningchair`, variant: ch.id, room: id })
          } else {
            items.push({ id: `g-${id}-dc${i}a`, type: "chair", name: ch.name, cx: r10(tb[0] - 300), cy: r10(tb[1] + (tb[3] - tb[1]) * f), w: ch.w, d: ch.d, rot: 90, color: ch.color, slot: "diningchair", slotKey: `${id}:diningchair`, variant: ch.id, room: id })
            items.push({ id: `g-${id}-dc${i}b`, type: "chair", name: ch.name, cx: r10(tb[2] + 300), cy: r10(tb[1] + (tb[3] - tb[1]) * f), w: ch.w, d: ch.d, rot: 270, color: ch.color, slot: "diningchair", slotKey: `${id}:diningchair`, variant: ch.id, room: id })
          }
        }
        dined = true
      }
      if (!dined) missing.push(`${id}:dining`)
    }
    if (k === "bedroom" || k === "study") {
      if (k === "bedroom") {
        const master = id === "master"
        const bed = placeWall(id, poly, "bed", `${id}:bed`, 600, (s) => farFromDoor(s) / 1000 - Math.abs(s.u) / 2000 - winCount(s) * 0.3, master ? ["bed180", "bed150", "bed120"] : ["bed150", "bed120", "bed180"])
        if (bed) {
          const { it, spot } = bed, b = boxOf(it.cx, it.cy, it.w, it.d, it.rot)
          const ns = VARIANTS.nightstand[0]
          for (const side of [-1, 1]) {
            const along = spot.e.horiz ? [side < 0 ? b[0] - ns.w / 2 - 20 : b[2] + ns.w / 2 + 20, 0] : [0, side < 0 ? b[1] - ns.w / 2 - 20 : b[3] + ns.w / 2 + 20]
            const n = spot.e.n, headOff = (it.d - ns.d) / 2
            const cx = spot.e.horiz ? along[0] : it.cx - n[0] * headOff, cy = spot.e.horiz ? it.cy - n[1] * headOff : along[1]
            const nb = boxOf(cx, cy, ns.w, ns.d, it.rot)
            if (freeBox(nb, poly)) add(id, "nightstand", `${id}:nightstand:${side}`, ns, cx, cy, it.rot, null)
          }
          // 床的一側要留 0.5 m 通道（床頭以外）
          reserved.push(grow(b, 0))
        }
        // 每間臥室盡量有衣櫃：大→小→吊衣架；前方淨空 0.65 m 放不下再退到 0.55 m（仍要站得到）
        const wScore = (s: { u: number; e: Edge }) => -Math.abs(s.u) / 3000 + (bed && s.e === bed.spot.e ? -2 : 0)
        if (!placeWall(id, poly, "wardrobe", `${id}:wardrobe`, 650, wScore)) {
          missing.pop()
          placeWall(id, poly, "wardrobe", `${id}:wardrobe`, 550, wScore)
        }
        if (!master) placeWall(id, poly, "desk", `${id}:desk`, 700, (s) => winCount(s))
      } else {
        const desk = placeWall(id, poly, "desk", `${id}:desk`, 750, (s) => winCount(s))
        if (desk) { const { it } = desk; const ch = VARIANTS.deskchair[0], n = desk.spot.e.n; const cx = it.cx + n[0] * (it.d / 2 + ch.d / 2 + 20), cy = it.cy + n[1] * (it.d / 2 + ch.d / 2 + 20); add(id, "deskchair", `${id}:deskchair`, ch, cx, cy, (it.rot + 180) % 360, null) }
        placeWall(id, poly, "bookshelf", `${id}:bookshelf`, 500, (s) => -winCount(s))
      }
    } else if (k === "bath") {
      placeWall(id, poly, "toilet", `${id}:toilet`, 550, (s) => farFromDoor(s) / 2000 - Math.abs(s.u) / 4000, undefined, 800)
      placeWall(id, poly, "shower", `${id}:shower`, 0, (s) => Math.abs(s.u) / 1000 + farFromDoor(s) / 1000, ["shower90", "tub"])
      placeWall(id, poly, "vanity", `${id}:vanity`, 500, (s) => -farFromDoor(s) / 1000)
    } else if (k === "kitchen") doKitchen()
    if (k === "living" && id === "living") {
      const openK = g.config.kitchen === "open"
      const snap = () => ({ i: items.length, r: reserved.length, m: missing.length })
      const s0 = snap()
      if (openK) doKitchen()
      doLiving()
      const noPair = () => missing.includes(`${id}:sofa+tv`)
      if (openK && noPair()) {
        // 客廳排不出沙發對電視：改成先擺沙發電視再擺廚具，比較好的那組留下
        const A = { i: items.slice(s0.i), r: reserved.slice(s0.r), m: missing.slice(s0.m) }
        items.length = s0.i; reserved.length = s0.r; missing.length = s0.m
        doLiving(); doKitchen()
        const okB = !noPair() && items.some((i) => i.room === id && i.type === "fridge") && items.some((i) => i.room === id && i.slot === "stove")
        if (!okB) { items.length = s0.i; reserved.length = s0.r; missing.length = s0.m; items.push(...A.i); reserved.push(...A.r); missing.push(...A.m) }
      }
    }
    if (k === "balcony" && (/工作陽台|曬衣/.test(room.name))) placeWall(id, poly, "washer", `${id}:washer`, 600, (s) => -Math.abs(s.u) / 1000)
  }
  return { items, missing }
}

/** 某槽位可換的款式。 */
export const swapOptions = (it: GameFurniture) => VARIANTS[it.slot]

/** 轉成編輯器 scheme 的家具清單（只留 scheme 欄位）。 */
export const toScheme = (items: GameFurniture[]): SchemeFurniture[] =>
  items.map(({ id, type, name, cx, cy, w, d, rot, color }) => ({ id, type, name, cx, cy, w, d, rot, color }))
