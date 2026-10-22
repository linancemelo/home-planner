/**
 * 範本戶型：由內部標註平面圖衍生的幾何（templates.json，只有座標，不含圖片）實例化成 GeneratedLayout。
 * 流程：座標變換（鏡像／旋轉，8 種）→ 依預算坪數等比縮放 → 牆線合併、開口嵌牆 → 套規則（客廳↔陽台落地窗、曬衣陽台命名、1 房時最小臥室改書房）。
 */
import { autoFurnish } from "../furnish/autoFurnish.ts"
import { validateFurniture } from "../furnish/validateFurniture.ts"
import { polishDoors } from "../scene/reach.ts"
import data from "./templates.json"
import precomputed from "./templateSpans.json"
import type { OpeningRect, PlanBlueprint, PlanRoom, SlidingDoor, SwingDoor, WallRect } from "../../plan/types/blueprint.ts"
import type { GeneratedLayout, LayoutConfig, Rect, RoomKind } from "./types.ts"
import { SQM_PER_PING } from "./types.ts"
import { distToPoly, pointInPoly, validateLayout } from "./validateLayout.ts"

type P = [number, number]
type TDoor = { name: string; opening: number[]; box: number[]; hinge?: number[]; sliding?: number }
export type Template = { id: string; rooms: { name: string; type: string; poly: number[][] }[]; walls: number[][]; doors: TDoor[]; windows: { name: string; seg: number[] }[]; halls?: number[][][] }
export const TEMPLATES: Template[] = (data as { templates: Template[] }).templates
export const SKIPPED_TEMPLATES: { id: string; reason: string }[] = (data as { skipped: { id: string; reason: string }[] }).skipped

const KIND: Record<string, RoomKind> = { bedroom: "bedroom", bathroom: "bath", living: "living", balcony: "balcony", kitchen: "kitchen" }
const r1 = (v: number) => Math.round(v)
const areaPx = (poly: number[][]) => Math.abs(poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p[0] * q[1] - q[0] * p[1] }, 0)) / 2
const countType = (t: Template, ty: string) => t.rooms.filter((r) => r.type === ty).length

/** 此範本能否做這個組合（只看房／衛／廚，不看坪數）。 */
export function templateFits(t: Template, cfg: Required<LayoutConfig>): boolean {
  if ((cfg.kitchen === "closed") !== countType(t, "kitchen") > 0) return false // 有獨立廚房的範本只給「獨立式」
  const beds = countType(t, "bedroom")
  return countType(t, "bathroom") === cfg.baths && (beds === cfg.bedrooms || beds - 1 === cfg.bedrooms)
}

/** 實例化。ping = 室內淨坪（不含陽台），tf = 0..7（bit2 鏡像，低 2 bit 旋轉 90°×n）。 */
export function instantiate(t: Template, cfg: Required<LayoutConfig>, tf: number): GeneratedLayout {
  // 先試「修掉懸空牆端」版；若因此驗證不過（例如窗旁短牆被修掉），退回不修的版本
  return build(t, cfg, tf, true)
}

function build(t: Template, cfg: Required<LayoutConfig>, tf: number, trim: boolean): GeneratedLayout {
  // --- 座標變換 + 縮放 ---
  const rot = tf & 3, mir = tf >> 2
  const tr0 = ([x, y]: number[]): P => {
    let a = mir ? -x : x, b = y
    for (let i = 0; i < rot; i++) [a, b] = [-b, a]
    return [a, b]
  }
  const allPts = t.walls.flatMap((w) => [tr0([w[0], w[1]]), tr0([w[2], w[3]])])
  const mx = Math.min(...allPts.map((p) => p[0])), my = Math.min(...allPts.map((p) => p[1]))
  const netPx = t.rooms.filter((r) => r.type !== "balcony").reduce((s, r) => s + areaPx(r.poly), 0)
  const S = Math.sqrt((cfg.ping * SQM_PER_PING * 1e6) / netPx) // mm / px
  const tp = (p: number[]): P => { const q = tr0(p); return [(q[0] - mx) * S, (q[1] - my) * S] }

  // --- 牆線 ---
  type Line = { horiz: boolean; c: number; th: number; spans: [number, number][]; holes: [number, number][] }
  const lines: Line[] = []
  const lineFor = (horiz: boolean, c: number, a: number, b: number, th?: number): Line => {
    let best: Line | null = null, bd = Infinity
    for (const l of lines) {
      if (l.horiz !== horiz) continue
      const d = Math.abs(l.c - c)
      if (d < Math.max(l.th, 150) && d < bd) { best = l; bd = d }
    }
    if (best) return best
    const l: Line = { horiz, c, th: th ?? 120, spans: [], holes: [] }
    lines.push(l)
    return l
  }
  const sorted = [...t.walls].sort((p, q) => Math.hypot(q[2] - q[0], q[3] - q[1]) - Math.hypot(p[2] - p[0], p[3] - p[1]))
  for (const w of sorted) {
    const [p0, p1] = [tp([w[0], w[1]]), tp([w[2], w[3]])]
    const horiz = Math.abs(p1[0] - p0[0]) >= Math.abs(p1[1] - p0[1])
    const th = Math.min(240, Math.max(100, w[4] * S))
    const c = horiz ? (p0[1] + p1[1]) / 2 : (p0[0] + p1[0]) / 2
    const [a, b] = horiz ? [Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0])] : [Math.min(p0[1], p1[1]), Math.max(p0[1], p1[1])]
    const l = lineFor(horiz, c, a, b, th)
    l.th = Math.max(l.th, th)
    l.spans.push([a, b])
  }
  // 牆端延伸半個厚度，讓轉角封閉
  const maxTh = Math.max(...lines.map((l) => l.th))
  // 只在端點碰到垂直牆時延伸到那面牆的外緣（不再一律外凸，避免外角突出的短牆）
  const orig = lines.map((l) => l.spans.map((s) => [...s] as [number, number]))
  const extendEnd = (l: Line, e: number, dir: -1 | 1): number => {
    let best: number | null = null
    lines.forEach((m, mi) => {
      if (m.horiz === l.horiz || Math.abs(m.c - e) > maxTh) return
      if (!orig[mi].some(([s0, s1]) => l.c >= s0 - maxTh && l.c <= s1 + maxTh)) return
      const face = m.c + (dir * m.th) / 2
      if (best === null || dir * face > dir * best) best = face
    })
    return best === null ? e : dir > 0 ? Math.max(e, best) : Math.min(e, best)
  }
  for (const l of lines) l.spans = l.spans.map(([a, b]) => [extendEnd(l, a, -1), extendEnd(l, b, 1)])

  // --- 房間 ---
  const rooms = t.rooms.map((r) => ({ src: r, kind: KIND[r.type], poly: r.poly.map(tp) as P[] }))
  const roomIdx = (p: P) => rooms.findIndex((r) => pointInPoly(p, r.poly))

  // --- 開口 ---
  type Op = { name: string; line: Line; a: number; b: number; door?: TDoor; win?: boolean; slide?: boolean }
  const ops: Op[] = []
  const place = (name: string, seg: number[]) => {
    const p0 = tp([seg[0], seg[1]]), p1 = tp([seg[2], seg[3]])
    const horiz = Math.abs(p1[0] - p0[0]) >= Math.abs(p1[1] - p0[1])
    const c = horiz ? (p0[1] + p1[1]) / 2 : (p0[0] + p1[0]) / 2
    const [a, b] = horiz ? [Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0])] : [Math.min(p0[1], p1[1]), Math.max(p0[1], p1[1])]
    const line = lineFor(horiz, c, a, b)
    return { name, line, a, b }
  }
  for (const d of t.doors) ops.push({ ...place(d.name, d.opening), door: d })
  for (const w of t.windows) ops.push({ ...place(w.name, w.seg), win: true, slide: /落地/.test(w.name) })

  // 開口端點若伸進垂直牆，裁到牆面；門寬改為常用尺寸（大門 1000、浴室 750、其他 850），靠鉸鏈端
  const perpBand = (op: Op) => lines.filter((m) => m.horiz !== op.line.horiz && m.spans.some(([s0, s1]) => op.line.c >= s0 - op.line.th / 2 && op.line.c <= s1 + op.line.th / 2))
  for (const op of ops) {
    for (const m of perpBand(op)) {
      const m0 = m.c - m.th / 2, m1 = m.c + m.th / 2
      if (m1 <= op.a || m0 >= op.b) continue
      if (m.c - op.a < op.b - m.c) op.a = Math.max(op.a, m1); else op.b = Math.min(op.b, m0)
    }
  }
  const rectOf = (l: Line, a: number, b: number): OpeningRect =>
    l.horiz ? [r1(a), r1(l.c - l.th / 2), r1(b), r1(l.c + l.th / 2)] : [r1(l.c - l.th / 2), r1(a), r1(l.c + l.th / 2), r1(b)]
  const sidesOf = (l: Line, a: number, b: number): [number, number] => {
    const m = (a + b) / 2, off = l.th / 2 + 300
    return l.horiz ? [roomIdx([m, l.c - off]), roomIdx([m, l.c + off])] : [roomIdx([l.c - off, m]), roomIdx([l.c + off, m])]
  }

  // 室外判定：從點往四個方向走，任一方向一路沒碰到牆線／開口／房間就到外框 → 室外
  const lineHit = (p: P) => lines.some((l) => {
    const acr = l.horiz ? p[1] : p[0], al = l.horiz ? p[0] : p[1]
    return Math.abs(acr - l.c) <= l.th / 2 + 30 && [...l.spans, ...l.holes].some(([a, b]) => al >= a - 30 && al <= b + 30)
  })
  const ext0 = (() => {
    const xs = lines.flatMap((l) => (l.horiz ? l.spans.flat() : [l.c])), ys = lines.flatMap((l) => (l.horiz ? [l.c] : l.spans.flat()))
    return [Math.min(...xs) - 200, Math.min(...ys) - 200, Math.max(...xs) + 200, Math.max(...ys) + 200]
  })()
  const isOutside = (p: P) => {
    if (roomIdx(p) >= 0) return false
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let q: P = [p[0], p[1]], hit = false
      while (q[0] > ext0[0] && q[0] < ext0[2] && q[1] > ext0[1] && q[1] < ext0[3]) {
        if (lineHit(q) || roomIdx(q) >= 0) { hit = true; break }
        q = [q[0] + dx * 80, q[1] + dy * 80]
      }
      if (!hit) return true
    }
    return false
  }
  // 通往未標示室外平台的門（非大門）→ 改成窗；與同牆相鄰的窗合併
  for (const op of ops) {
    if (!op.door || /大門/.test(op.door.name)) continue
    const [sa, sb] = sidesOf(op.line, op.a, op.b)
    if (sa >= 0 && sb >= 0) continue
    const m = (op.a + op.b) / 2, off = op.line.th / 2 + 300
    const pa: P = op.line.horiz ? [m, op.line.c - off] : [op.line.c - off, m], pb: P = op.line.horiz ? [m, op.line.c + off] : [op.line.c + off, m]
    if ((sa < 0 && isOutside(pa)) || (sb < 0 && isOutside(pb))) { op.door = undefined; op.win = true; op.slide = false }
  }
  for (let i = 0; i < ops.length; i++) for (let j = 0; j < ops.length; j++) {
    const a = ops[i], b = ops[j]
    if (i === j || !a.win || !b.win || a.slide || b.slide || a.line !== b.line || a.a < 0) continue
    if (b.a >= a.a && b.a - a.b < 200) { a.b = Math.max(a.b, b.b); b.a = -1e9; b.b = -1e9 }
  }
  for (let i = ops.length - 1; i >= 0; i--) if (ops[i].a === -1e9) ops.splice(i, 1)

  // --- 房間 id／名稱 ---
  const kinds: Record<string, RoomKind> = {}, zones: Record<string, Rect> = {}
  const ids: string[] = rooms.map(() => "")
  const names: string[] = rooms.map((r) => r.src.name)
  const beds = rooms.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "bedroom").sort((p, q) => areaPx(q.r.src.poly) - areaPx(p.r.src.poly))
  const studyIdx = beds.length - 1 === cfg.bedrooms ? beds[beds.length - 1].i : -1
  beds.forEach((x, k) => {
    if (x.i === studyIdx) { ids[x.i] = "study"; names[x.i] = "書房"; rooms[x.i].kind = "study"; return }
    ids[x.i] = k === 0 ? "master" : `bed${k + 1}`
    names[x.i] = k === 0 ? "主臥室" : cfg.bedrooms === 2 ? "次臥室" : `臥室${k + 1}`
  })
  let nb = 0, nl = 0
  const bals = rooms.map((r, i) => ({ r, i })).filter((x) => x.r.kind === "balcony").sort((p, q) => areaPx(q.r.src.poly) - areaPx(p.r.src.poly))
  const hasService = bals.some((x) => /工作|曬衣/.test(x.r.src.name))
  bals.forEach((x, k) => {
    const service = /工作|曬衣/.test(x.r.src.name)
    ids[x.i] = service ? "svcbalcony" : k === 0 ? "balcony" : `balcony${k + 1}`
    names[x.i] = service ? "工作陽台" : !hasService && k === 0 ? "陽台（可曬衣）" : "陽台"
  })
  rooms.forEach((r, i) => {
    if (r.kind === "bath") { nb++; ids[i] = `bath${nb}`; names[i] = nb === 1 ? "衛浴" : `衛浴${nb}` }
    if (r.kind === "kitchen") { ids[i] = "kitchen"; names[i] = "廚房" }
    if (r.kind === "living") { nl++; ids[i] = nl === 1 ? "living" : `living${nl}`; names[i] = cfg.livings === 2 ? "客餐廳" : "客廳（含開放廚房）" }
  })

  // --- 門窗 ---
  const windowOpenings: OpeningRect[] = [], swingDoors: SwingDoor[] = [], slidingDoors: SlidingDoor[] = []
  const viaName = new Map<SwingDoor, string>() // 門的另一側房名：同名門（如 y02 兩扇主臥室門）用來區分
  for (const op of ops) {
    const l = op.line, rect = rectOf(l, op.a, op.b)
    const [sa, sb] = sidesOf(l, op.a, op.b)
    const ka = sa >= 0 ? rooms[sa].kind : null, kb = sb >= 0 ? rooms[sb].kind : null
    const livBal = (ka === "living" && kb === "balcony") || (kb === "living" && ka === "balcony")
    if (livBal && (op.door || op.slide)) { slidingDoors.push({ rect, v: !l.horiz }); continue }
    if (op.win && !op.slide) { windowOpenings.push(rect); continue }
    if (op.win && op.slide) { // 非客廳的落地窗 → 依規則改成門
      op.door = { name: op.name, opening: [], box: [] }
    }
    const d = op.door!
    const entry = /大門/.test(d.name)
    // 開向：大門往室內開；其餘依標註門扇框位置
    let oSign: number
    if (entry) oSign = sa >= 0 && sb < 0 ? -1 : 1
    else if (d.box.length) {
      const b0 = tp([d.box[0], d.box[1]]), b1 = tp([d.box[2], d.box[3]])
      const bc = l.horiz ? (b0[1] + b1[1]) / 2 : (b0[0] + b1[0]) / 2
      oSign = bc >= l.c ? 1 : -1
    } else oSign = kb === "bath" || kb === "bedroom" ? 1 : -1
    // 鉸鏈端
    let hingeAtA = true
    if (d.hinge) {
      const hp = tp(d.hinge), ha = l.horiz ? hp[0] : hp[1]
      hingeAtA = Math.abs(ha - op.a) <= Math.abs(ha - op.b)
    }
    const std = entry ? 1000 : kb === "bath" || ka === "bath" ? 750 : 850
    if (op.b - op.a > std) { if (hingeAtA) op.b = op.a + std; else op.a = op.b - std }
    const len = op.b - op.a
    const along = hingeAtA ? op.a : op.b, across = l.c + (oSign * l.th) / 2
    const h: P = l.horiz ? [r1(along), r1(across)] : [r1(across), r1(along)]
    const c: P = l.horiz ? [hingeAtA ? 1 : -1, 0] : [0, hingeAtA ? 1 : -1]
    const o: P = l.horiz ? [0, oSign] : [oSign, 0]
    // 門名取「門通往的那間」：隱私高的一側（衛浴 > 臥室／書房／儲藏 > 廚房 > 陽台 > 客廳／走廊），不受開向影響
    const RANK: Record<string, number> = { bath: 5, bedroom: 4, study: 4, storage: 4, kitchen: 3, balcony: 2, living: 1 }
    const into = sa < 0 ? sb : sb < 0 ? sa : (RANK[ka!] ?? 0) >= (RANK[kb!] ?? 0) ? sa : sb
    const name = entry ? "大門" : `${names[into] ?? ""}門`.replace(/^門$/, d.name)
    const sd: SwingDoor = { name, rect: rectOf(l, op.a, op.b), h, c, o, len: r1(len), ...(entry ? { entry: true } : {}) }
    viaName.set(sd, names[into === sa ? sb : sa] ?? "")
    swingDoors.push(sd)
  }

  // --- 牆實體：開口兩端補短牆，合併小縫，挖掉開口 ---
  const touchesPerp = (op: Op, x: number) => perpBand(op).some((m) => x >= m.c - m.th / 2 - 25 && x <= m.c + m.th / 2 + 25)
  for (const op of ops) {
    op.line.holes.push([op.a, op.b])
    if (!touchesPerp(op, op.a)) op.line.spans.push([op.a - 150, op.a])
    if (!touchesPerp(op, op.b)) op.line.spans.push([op.b, op.b + 150])
  }
  const walls: WallRect[] = []
  const bbW = [Math.min(...lines.map((l) => (l.horiz ? Math.min(...l.spans.map((s) => s[0])) : l.c))), Math.max(...lines.map((l) => (l.horiz ? Math.max(...l.spans.map((s) => s[1])) : l.c)))]
  const bbH = [Math.min(...lines.map((l) => (!l.horiz ? Math.min(...l.spans.map((s) => s[0])) : l.c))), Math.max(...lines.map((l) => (!l.horiz ? Math.max(...l.spans.map((s) => s[1])) : l.c)))]
  for (const l of lines) {
    const iv = [...l.spans, ...l.holes].sort((p, q) => p[0] - q[0])
    const merged: [number, number][] = []
    for (const [a, b] of iv) {
      const last = merged[merged.length - 1]
      if (last && a <= last[1] + 300) last[1] = Math.max(last[1], b); else merged.push([a, b])
    }
    const holes = [...l.holes].sort((p, q) => p[0] - q[0])
    const ext = l.horiz ? l.c - l.th <= bbH[0] + 1 || l.c + l.th >= bbH[1] - 1 : l.c - l.th <= bbW[0] + 1 || l.c + l.th >= bbW[1] - 1
    for (const [a, b] of merged) {
      let cur = a
      for (const [ha, hb] of holes) {
        if (hb <= a || ha >= b) continue
        if (ha > cur + 1) walls.push([...rectOf(l, cur, ha), ext ? "e" : "n"] as WallRect)
        cur = Math.max(cur, hb)
      }
      if (b > cur + 1) walls.push([...rectOf(l, cur, b), ext ? "e" : "n"] as WallRect)
    }
  }

  const hallPolys = (t.halls ?? []).map((h) => h.map(tp))
  // --- 修掉懸空牆（標註牆線超出房間外緣）：牆片上離所有房間 > 0.3 m 的部分切掉，只留靠近房間的段 ---
  {
    const polys = [...rooms.map((r) => r.poly), ...hallPolys]
    const keepAt = (p: P, th: number) => polys.some((poly) => distToPoly(p, poly) <= th / 2 + 250)
    const next: WallRect[] = []
    for (const w of walls) {
      if (w[4] === "low") { next.push(w); continue }
      const horiz = w[2] - w[0] >= w[3] - w[1], th = horiz ? w[3] - w[1] : w[2] - w[0], mid = horiz ? (w[1] + w[3]) / 2 : (w[0] + w[2]) / 2
      const a0 = horiz ? w[0] : w[1], a1 = horiz ? w[2] : w[3], n = Math.max(1, Math.ceil((a1 - a0) / 50)), step = (a1 - a0) / n
      let run: number | null = null
      for (let k = 0; k <= n; k++) {
        const uu = a0 + step * k, ok = keepAt(horiz ? [uu, mid] : [mid, uu], th)
        if (ok && run === null) run = k === 0 ? a0 : uu - step / 2
        if ((!ok || k === n) && run !== null) {
          const end = ok ? a1 : uu - step / 2
          if (end - run > 20) next.push((horiz ? [r1(run), w[1], r1(end), w[3], w[4]] : [w[0], r1(run), w[2], r1(end), w[4]]) as WallRect)
          run = null
        }
      }
    }
    walls.length = 0; walls.push(...next)
  }
  // --- 開口衝突：同一處重複標的門只留一個；與門／落地窗太近的窗拿掉（標註雜訊） ---
  // 拿掉的開口原位補牆，但扣掉與保留開口重疊的部分
  const fillHole = (r: readonly number[], kind: "n" | "e") => {
    const horiz = r[2] - r[0] >= r[3] - r[1]
    let pieces: [number, number][] = [horiz ? [r[0], r[2]] : [r[1], r[3]]]
    for (const o of [...windowOpenings, ...swingDoors.map((d) => d.rect), ...slidingDoors.map((d) => d.rect)]) {
      if (horiz ? o[1] >= r[3] || o[3] <= r[1] : o[0] >= r[2] || o[2] <= r[0]) continue
      const [oa, ob] = horiz ? [o[0], o[2]] : [o[1], o[3]]
      pieces = pieces.flatMap(([a, b]) => (ob <= a || oa >= b ? [[a, b]] : [[a, Math.min(b, oa)], [Math.max(a, ob), b]].filter(([x, y]) => y - x > 1)) as [number, number][])
    }
    for (const [a, b] of pieces) walls.push((horiz ? [a, r[1], b, r[3], kind] : [r[0], a, r[2], b, kind]) as WallRect)
  }
  const near = (a: readonly number[], b: readonly number[]) => a[0] < b[2] + 100 && a[2] > b[0] - 100 && a[1] < b[3] + 100 && a[3] > b[1] - 100
  for (let i = swingDoors.length - 1; i >= 0; i--) {
    const d = swingDoors[i]
    // 重複＝同方向且幾乎同位置；牆角兩扇互相垂直的門是真實格局常見的，保留
    const hz = (r: readonly number[]) => r[2] - r[0] >= r[3] - r[1]
    if (!d.entry && (swingDoors.some((e, j) => j < i && hz(e.rect) === hz(d.rect) && near(d.rect, e.rect)) || slidingDoors.some((e) => near(d.rect, e.rect)))) fillHole(swingDoors.splice(i, 1)[0].rect, "n")
  }
  for (let i = windowOpenings.length - 1; i >= 0; i--) {
    const w = windowOpenings[i]
    if ([...swingDoors.map((d) => d.rect), ...slidingDoors.map((d) => d.rect)].some((r) => near(w, r)) || windowOpenings.some((e, j) => j < i && near(w, e))) fillHole(windowOpenings.splice(i, 1)[0], "e")
  }
  // （被拿掉的開口原位補回同厚度的牆片）
  // --- 落地窗至少 1.8 m：沿牆往兩側加寬（只在客廳／陽台共用邊內、不碰其他開口），並把被占用的牆切掉 ---
  for (const sd of slidingDoors) {
    const r = sd.rect, horiz = r[2] - r[0] >= r[3] - r[1], w = horiz ? r[2] - r[0] : r[3] - r[1]
    if (w >= 1800) continue
    const th = horiz ? r[3] - r[1] : r[2] - r[0], mid = horiz ? (r[1] + r[3]) / 2 : (r[0] + r[2]) / 2, off = th / 2 + 300
    const okAt = (u: number) => {
      const ks = (horiz ? [[u, mid - off], [u, mid + off]] : [[mid - off, u], [mid + off, u]]).map((p) => { const i = roomIdx(p as P); return i >= 0 ? rooms[i].kind : null })
      return ks.includes("living") && ks.includes("balcony")
    }
    const others = [...windowOpenings, ...swingDoors.map((d) => d.rect), ...slidingDoors.filter((x) => x !== sd).map((x) => x.rect)]
    const free = (a: number, b: number) => !others.some((o) => (horiz ? o[0] < b + 100 && o[2] > a - 100 && Math.abs((o[1] + o[3]) / 2 - mid) < th : o[1] < b + 100 && o[3] > a - 100 && Math.abs((o[0] + o[2]) / 2 - mid) < th))
    let a = horiz ? r[0] : r[1], b = horiz ? r[2] : r[3]
    for (let guard = 0; guard < 60 && b - a < 1800; guard++) {
      const grewB = okAt(b + 50) && free(a, b + 50) ? (b += 50, true) : false
      const grewA = b - a < 1800 && okAt(a - 50) && free(a - 50, b) ? (a -= 50, true) : false
      if (!grewA && !grewB) break
    }
    sd.rect = (horiz ? [r1(a), r[1], r1(b), r[3]] : [r[0], r1(a), r[2], r1(b)]) as OpeningRect
    // 切牆
    const cut: WallRect[] = []
    for (const wl of walls) {
      const ov = wl[0] < sd.rect[2] - 1 && wl[2] > sd.rect[0] + 1 && wl[1] < sd.rect[3] - 1 && wl[3] > sd.rect[1] + 1
      if (!ov) { cut.push(wl); continue }
      if (horiz) { if (wl[0] < sd.rect[0]) cut.push([wl[0], wl[1], sd.rect[0], wl[3], wl[4]] as WallRect); if (wl[2] > sd.rect[2]) cut.push([sd.rect[2], wl[1], wl[2], wl[3], wl[4]] as WallRect) }
      else { if (wl[1] < sd.rect[1]) cut.push([wl[0], wl[1], wl[2], sd.rect[1], wl[4]] as WallRect); if (wl[3] > sd.rect[3]) cut.push([wl[0], sd.rect[3], wl[2], wl[3], wl[4]] as WallRect) }
    }
    walls.length = 0; walls.push(...cut)
  }

  // --- 門扇撞牆或壓到其他開口 → 依序試：換鉸鏈端、換開向（大門只能往內開，只換鉸鏈端） ---
  const allOps = () => [...windowOpenings, ...slidingDoors.map((d) => d.rect), ...swingDoors.map((d) => d.rect)]
  const swingBad = (d: SwingDoor) => {
    const L = d.len, [hx, hy] = d.h
    const xs = [hx, hx + d.c[0] * L, hx + d.o[0] * L], ys = [hy, hy + d.c[1] * L, hy + d.o[1] * L]
    const sw = [Math.min(...xs) + 5, Math.min(...ys) + 5, Math.max(...xs) - 5, Math.max(...ys) - 5]
    const hit = (o: readonly unknown[]) => sw[0] < (o[2] as number) && sw[2] > (o[0] as number) && sw[1] < (o[3] as number) && sw[3] > (o[1] as number)
    return walls.some(hit) || allOps().some((o) => o !== d.rect && hit(o))
  }
  for (const d of swingDoors) {
    if (!swingBad(d)) continue
    const [x0, y0, x1, y1] = d.rect, horiz = x1 - x0 > y1 - y0
    const orig = { h: d.h, c: d.c, o: d.o }
    let fixed = false
    for (const flipO of d.entry ? [false] : [false, true]) for (const atA of [true, false]) {
      if (fixed) break
      const oS = (horiz ? orig.o[1] : orig.o[0]) * (flipO ? -1 : 1)
      const face = horiz ? (oS > 0 ? y1 : y0) : (oS > 0 ? x1 : x0)
      d.h = horiz ? [atA ? x0 : x1, face] : [face, atA ? y0 : y1]
      d.c = horiz ? [atA ? 1 : -1, 0] : [0, atA ? 1 : -1]
      d.o = horiz ? [0, oS] : [oS, 0]
      if (!swingBad(d)) fixed = true
    }
    if (!fixed) Object.assign(d, orig)
  }

  // --- 房間（含陽台）外露的邊：室內房間補實牆、陽台補欄杆（low，1.1 m）；面向走道／其他房間的開放邊不補 ---
  const covered = (p: P) => [...walls, ...windowOpenings, ...slidingDoors.map((d) => d.rect), ...swingDoors.map((d) => d.rect)]
    .some((w) => p[0] > w[0] - 60 && p[0] < w[2] + 60 && p[1] > w[1] - 60 && p[1] < w[3] + 60)
  for (const r of rooms) {
    const isBal = r.kind === "balcony"
    for (let i = 0; i < r.poly.length; i++) {
      const a = r.poly[i], b = r.poly[(i + 1) % r.poly.length]
      const horiz = Math.abs(b[1] - a[1]) < 1
      if (!horiz && Math.abs(b[0] - a[0]) > 1) continue // 斜邊不處理
      const L = horiz ? Math.abs(b[0] - a[0]) : Math.abs(b[1] - a[1]), n = Math.max(1, Math.round(L / 50))
      const mid: P = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
      const outSign = horiz ? (pointInPoly([mid[0], mid[1] + 50], r.poly) ? -1 : 1) : (pointInPoly([mid[0] + 50, mid[1]], r.poly) ? -1 : 1)
      let run: number | null = null
      const lo = horiz ? Math.min(a[0], b[0]) : Math.min(a[1], b[1])
      for (let k = 0; k <= n; k++) {
        const u = lo + (L * k) / n
        const p: P = horiz ? [u, a[1]] : [a[0], u]
        const pOut: P = horiz ? [p[0], p[1] + outSign * 300] : [p[0] + outSign * 300, p[1]]
        const free = !covered(p) && k < n && (isBal ? roomIdx(pOut) < 0 : isOutside(pOut))
        if (free && run === null) run = u
        if ((!free || k === n) && run !== null) {
          const u1 = free ? u : u
          if (u1 - run > 40) {
            const e0 = horiz ? a[1] : a[0], e1 = e0 + outSign * (isBal ? 100 : 150)
            const ra = Math.max(lo, run - 60), rb = Math.min(lo + L, u1 + 60)
            walls.push((horiz ? [r1(ra), r1(Math.min(e0, e1)), r1(rb), r1(Math.max(e0, e1)), isBal ? "low" : "e"] : [r1(Math.min(e0, e1)), r1(ra), r1(Math.max(e0, e1)), r1(rb), isBal ? "low" : "e"]) as WallRect)
          }
          run = null
        }
      }
    }
  }

  // --- planRooms ---
  const matOf = (k: RoomKind, id: string) => (k === "bath" ? "antislip" : k === "balcony" ? (id === "svcbalcony" ? "antislip" : "walnut") : "wood")
  const planRooms: PlanRoom[] = rooms.map((r, i) => {
    const poly = r.poly.map(([x, y]) => [r1(x), r1(y)] as P)
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
    const z: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    kinds[ids[i]] = r.kind; zones[ids[i]] = z
    return { id: ids[i], name: names[i], poly, mat: matOf(r.kind, ids[i]), at: interiorPoint(poly, walls), ...(r.kind === "balcony" ? { counted: false } : {}) }
  })
  // 走道存成室內空間「走廊」（有地板、HUD 顯示、預覽有顏色）；不計入室內坪（與範本坪數換算一致）
  hallPolys.forEach((hp, k) => {
    const poly = hp.map(([x, y]) => [r1(x), r1(y)] as P), xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]), id = `hall${k + 1}`
    // 小凹口（< 2 m² 或短邊 < 0.8 m，例如衛浴旁的牆凹）不算走廊
    if (areaPx(poly) < 2e6 || Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) < 800) return
    kinds[id] = "hall"; zones[id] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    planRooms.push({ id, name: "走廊", poly, mat: "wood", at: interiorPoint(poly, walls), counted: false })
  })

  // --- 出生點：大門外 ---
  // 同名門加註另一側（「主臥室門（客餐廳側）」），另一側也同名時加序號
  const byName = new Map<string, SwingDoor[]>()
  for (const d of swingDoors) byName.set(d.name, [...(byName.get(d.name) ?? []), d])
  for (const [n, ds] of byName) if (ds.length > 1) {
    const vias = ds.map((d) => viaName.get(d) || "")
    const uniq = vias.every((v) => v) && new Set(vias).size === ds.length
    ds.forEach((d, k) => { d.name = uniq ? `${n}（${vias[k]}側）` : `${n}${k + 1}` })
  }
  const ed = swingDoors.find((d) => d.entry)
  let spawn = { at: [0, 0] as P, lookAt: [0, 0] as P }, entrySide: GeneratedLayout["entrySide"] = "W"
  if (ed) {
    const [x0, y0, x1, y1] = ed.rect, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    const out: P = [-ed.o[0], -ed.o[1]]
    spawn = { at: [r1(cx + out[0] * 1700), r1(cy + out[1] * 1700)], lookAt: [r1(cx - out[0] * 1500), r1(cy - out[1] * 1500)] }
    entrySide = out[0] < 0 ? "W" : out[0] > 0 ? "E" : out[1] < 0 ? "N" : "S"
  }
  const lz = zones.living
  const livingAreas = cfg.livings === 2 && lz
    ? (lz[2] - lz[0] >= lz[3] - lz[1]
      ? [{ name: "客廳區", rect: [lz[0], lz[1], r1((lz[0] + lz[2]) / 2), lz[3]] as Rect }, { name: "餐廳區", rect: [r1((lz[0] + lz[2]) / 2), lz[1], lz[2], lz[3]] as Rect }]
      : [{ name: "客廳區", rect: [lz[0], lz[1], lz[2], r1((lz[1] + lz[3]) / 2)] as Rect }, { name: "餐廳區", rect: [lz[0], r1((lz[1] + lz[3]) / 2), lz[2], lz[3]] as Rect }])
    : []

  const pa = (poly: P[]) => areaPx(poly)
  const net = planRooms.filter((r) => kinds[r.id] !== "balcony" && kinds[r.id] !== "hall").reduce((s, r) => s + pa(r.poly), 0)
  const bal = planRooms.filter((r) => kinds[r.id] === "balcony").reduce((s, r) => s + pa(r.poly), 0)
  const W = bbW[1], D = bbH[1]
  const blueprint: PlanBlueprint = {
    id: `tpl-${t.id}-${tf}-${cfg.bedrooms}r${cfg.livings}l${cfg.baths}b-${Math.round(cfg.ping * 10)}`,
    name: `${cfg.bedrooms}房${cfg.livings}廳${cfg.baths}衛 · 系統配置`,
    source: "generated",
    walls, windowOpenings, swingDoors, slidingDoors, planRooms,
    bounds: { x: -3500, y: -3500, w: r1(W + 7000), h: r1(D + 7000) },
    origin: { ox: r1(W / 2), oy: r1(D / 2) },
    notes: [`系統配置：範本 ${t.id}（由內部標註平面圖衍生）變換 ${tf}，室內淨面積約 ${(net / 1e6 / SQM_PER_PING).toFixed(1)} 坪（不含陽台）`],
  }
  const schemeRooms: Record<string, { name: string; mat: string }> = {}
  planRooms.forEach((r) => (schemeRooms[r.id] = { name: r.name, mat: r.mat }))
  return {
    config: cfg, blueprint, scheme: { furniture: [], rooms: schemeRooms, demolished: [], measures: [] }, kinds, spawn,
    zones, openKitchenZone: null, livingAreas, halls: hallPolys, corridorY: lz ? lz[1] : 0, entrySide,
    areaPing: Math.round((net / 1e6 / SQM_PER_PING) * 10) / 10,
    balconyPing: Math.round((bal / 1e6 / SQM_PER_PING) * 10) / 10,
    variant: { flip: mir === 1, ensuite: false, bathsSouth: false, movedBedrooms: 0, storage: false, source: "template", template: t.id, transform: tf },
  }
}

/** 房內標記點：優先用外框中心，否則找離邊最遠的格點。 */
function interiorPoint(poly: P[], walls: WallRect[]): P {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1])
  const c: P = [r1((Math.min(...xs) + Math.max(...xs)) / 2), r1((Math.min(...ys) + Math.max(...ys)) / 2)]
  const inWall = (p: P) => walls.some((w) => p[0] > w[0] && p[0] < w[2] && p[1] > w[1] && p[1] < w[3])
  if (pointInPoly(c, poly) && !inWall(c)) return c
  let best = c, bd = -1
  for (let x = Math.min(...xs); x <= Math.max(...xs); x += 100) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 100) {
    const p: P = [x, y]
    if (!pointInPoly(p, poly) || inWall(p)) continue
    const d = Math.min(...poly.map((a, i) => segDist(p, a, poly[(i + 1) % poly.length])))
    if (d > bd) { bd = d; best = [r1(x), r1(y)] }
  }
  return best
}
function segDist(p: P, a: P, b: P): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}

/** 範本在哪段坪數內（不含預算檢查）能通過驗證：1 坪步進掃描，取最長連續段。結果快取。 */
const tplSpanCache = new Map<string, [number, number] | null>()
export const spanKey = (t: Template, cfg: Required<LayoutConfig>) => `${t.id}|${cfg.bedrooms}|${cfg.livings}|${cfg.baths}`
/** 預先算好的可行段（scripts/precompute-template-spans.ts 產生；test:layout 會核對與即時計算一致），避免 UI 首次切換組合卡 4 秒。 */
export function templateSpan(t: Template, cfg: Required<LayoutConfig>, fresh = false): [number, number] | null {
  const k = spanKey(t, cfg)
  const pre = (precomputed as unknown as Record<string, [number, number] | null>)[k]
  if (!fresh && pre !== undefined) return pre
  if (tplSpanCache.has(k)) return tplSpanCache.get(k)!
  const ok: number[] = []
  for (let p = 10; p <= 60; p++) {
    const g = instantiate(t, { ...cfg, ping: p }, 0)
    // 也要擺得下必要家具（半套衛浴、走道式廚房的範本在該組合會被排除；generateLayout 另有同樣閘門擋其他變換）
    if (validateLayout(g, { budget: false }).length === 0 && (polishDoors(g), validateLayout(g, { budget: false }).length === 0) && validateFurniture(g, autoFurnish(g).items).length === 0) ok.push(p)
  }
  let best: [number, number] | null = null, cur: [number, number] | null = null
  for (const p of ok) {
    cur = cur && p === cur[1] + 1 ? [cur[0], p] : [p, p]
    if (!best || cur[1] - cur[0] > best[1] - best[0]) best = [...cur] as [number, number]
  }
  tplSpanCache.set(k, best)
  return best
}

export function templateDiagnostics(t: Template, cfg: Required<LayoutConfig>, tf = 0): string[] {
  return validateLayout(instantiate(t, cfg, tf), { budget: false })
}
