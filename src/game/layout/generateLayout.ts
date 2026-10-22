/**
 * 系統配置戶型產生器 v2（純函式、決定性）。
 * 北帶：主臥（可含主臥衛浴）＋臥室＋（衛浴）＋（大坪數時儲藏室）；
 * 南帶：西側開放「客餐廳」（不切房），東側經走道連到衛浴／獨立廚房／多出的臥室。
 * 客餐廳→陽台＝落地窗；獨立廚房→工作陽台＝門；大門在客餐廳外牆。依 seed 左右鏡像與變體。
 * 坪數＝各房淨面積合計（不含陽台）；以成長係數 g 二分搜尋到預算 ±5%，不可行時丟 BudgetError。
 */
import { autoFurnish } from "../furnish/autoFurnish.ts"
import { validateFurniture } from "../furnish/validateFurniture.ts"
import { polishDoors } from "../scene/reach.ts"
import type { OpeningRect, PlanBlueprint, PlanRoom, SlidingDoor, SwingDoor, WallKind, WallRect } from "../../plan/types/blueprint.ts"
import { mulberry32 } from "./rng.ts"
import { TEMPLATES, instantiate, templateFits, templateSpan, type Template } from "./templateLayout.ts"
import { validateLayout } from "./validateLayout.ts"
import { BudgetError, PING_ABS_MAX, SQM_PER_PING, type GeneratedLayout, type LayoutConfig, type Rect, type RoomKind } from "./types.ts"

const EXT = 200, T = 120, HALF = 60
const r10 = (v: number) => Math.round(v / 10) * 10

type Seg = { horiz: boolean; across: [number, number]; along: [number, number]; kind: WallKind; holes: [number, number][] }
function cutSegs(segs: Seg[]): WallRect[] {
  const out: WallRect[] = []
  for (const s of segs) {
    const holes = [...s.holes].sort((a, b) => a[0] - b[0])
    let cur = s.along[0]
    const pieces: [number, number][] = []
    for (const [h0, h1] of holes) { if (h0 > cur) pieces.push([cur, h0]); cur = Math.max(cur, h1) }
    if (cur < s.along[1]) pieces.push([cur, s.along[1]])
    for (const [a, b] of pieces) if (b - a >= 1) out.push(s.horiz ? [a, s.across[0], b, s.across[1], s.kind] : [s.across[0], a, s.across[1], b, s.kind])
  }
  return out
}
const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
export function polyArea(poly: [number, number][]): number {
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1])
  return Math.abs(a / 2)
}

export function normalizeConfig(c: Partial<LayoutConfig>): Required<LayoutConfig> {
  const num = (v: unknown, name: string) => {
    if (v === undefined) return undefined
    if (typeof v !== "number" || !Number.isFinite(v)) throw new BudgetError(`${name}不是有效的數字`, null)
    return v
  }
  const b = num(c.bedrooms, "房間數") ?? 2, ba = num(c.baths, "衛浴數") ?? 1, l = num(c.livings, "廳數") ?? 1
  const ping = num(c.ping, "坪數"), seed = num(c.seed, "seed") ?? 1
  const cfg = {
    bedrooms: Math.min(4, Math.max(1, Math.round(b))) as LayoutConfig["bedrooms"],
    livings: (l >= 2 ? 2 : 1) as 1 | 2,
    baths: Math.min(3, Math.max(1, Math.round(ba))) as LayoutConfig["baths"],
    kitchen: c.kitchen === "closed" ? "closed" as const : "open" as const,
    seed: Math.abs(Math.round(seed)) >>> 0,
    ping: 0,
  }
  cfg.ping = ping ?? defaultPing(cfg)
  return cfg
}

type Variant = GeneratedLayout["variant"] & { jit: number }
function variantOf(cfg: Required<LayoutConfig>): Variant {
  const r = mulberry32(cfg.seed * 2654435761 + cfg.bedrooms * 97 + cfg.baths * 13 + cfg.livings * 7)
  const flip = r() < 0.5, ens = r(), bs = r(), jit = r()
  return { flip, ensuite: cfg.baths >= 2 && ens < 0.7, bathsSouth: bs < 0.5, movedBedrooms: 0, storage: false, jit }
}

type Cell = { id: string; name: string; kind: RoomKind; w: number; ensuite?: number }

/** 依成長係數 g（0＝最小、1＝最大）建出未鏡像的戶型（不含家具）。 */
function build(cfg: Required<LayoutConfig>, v: Variant, g: number): GeneratedLayout {
  const ln = (a: number, b: number) => a + (b - a) * g
  const Dn = r10(ln(3300, 4000 + v.jit * 200))
  const Hw = r10(ln(1100, 1300))
  const north: Cell[] = [], south: Cell[] = []
  const ensuite = v.ensuite ? r10(ln(1700, 2100)) : 0
  north.push({ id: "master", name: "主臥室", kind: "bedroom", w: r10(ln(3400, 4600)), ensuite })
  for (let i = 1; i < cfg.bedrooms; i++) north.push({ id: `bed${i + 1}`, name: cfg.bedrooms === 2 ? "次臥室" : `臥室${i + 1}`, kind: "bedroom", w: r10(ln(2900, 3700)) })
  const hallBaths = cfg.baths - (v.ensuite ? 1 : 0)
  const baths: Cell[] = []
  for (let i = 0; i < hallBaths; i++) baths.push({ id: `bath${i + 1}`, name: i === 0 ? "衛浴" : `衛浴${i + 1}`, kind: "bath", w: r10(ln(1700, 2200)) })
  ;(v.bathsSouth ? south : north).push(...baths)
  if (cfg.kitchen === "closed") south.push({ id: "kitchen", name: "廚房", kind: "kitchen", w: r10(ln(2300, 3000)) })

  const rowW = (cs: Cell[]) => cs.reduce((s, c) => s + c.w + (c.ensuite ? c.ensuite + T : 0), 0) + Math.max(0, cs.length - 1) * T
  const Aliv = ((cfg.livings === 2 ? 26 : 19) + ln(0, 30) + (cfg.kitchen === "open" ? 5 : 0)) * 1e6
  // 南排房間（衛浴／廚房／臥室）深度上限，避免狹長
  const DsMax = () => (south.length ? Hw + T + (south.some((c) => c.kind === "bedroom") ? 3800 : 3000) : 99999)
  const seMinDepth = () => (south.some((c) => c.kind === "bedroom") ? 3000 : south.length ? 2200 : 0)
  let Ds = 0, Lw = 0, movedBedrooms = 0
  const calc = () => {
    Ds = r10(Math.max(cfg.livings === 2 ? 3800 : 3500, Math.min(DsMax(), Math.sqrt(Aliv / 1.5)), south.length ? Hw + T + seMinDepth() : 0))
    Lw = r10(Math.max(3600, Aliv / Ds))
    return Lw + (south.length ? T + rowW(south) : 0)
  }
  let Ws = calc(), Wn = rowW(north)
  // 北排太長：把最後一間（非主臥）臥室移到南帶東側
  while (Wn > Ws + 2000 && north.filter((c) => c.kind === "bedroom").length > 2) {
    const i = north.map((c) => c.kind).lastIndexOf("bedroom")
    south.unshift(north.splice(i, 1)[0]); movedBedrooms++
    Ws = calc(); Wn = rowW(north)
  }
  let storage = false
  if (Wn > Ws) Lw += Wn - Ws
  else if (Ws > Wn) {
    // 南排較寬：先把客餐廳改深改窄（面積不變），再把剩餘寬度分給北排（有上限），最後才加儲藏室
    const minLw = Math.max(3600, Wn - (south.length ? T + rowW(south) : 0))
    if (minLw < Lw) { const nl = r10(Math.max(minLw, Math.sqrt(Aliv / 1.6))); if (nl < Lw) { Ds = r10(Math.min(DsMax(), Math.max(Ds, Math.min(Aliv / nl, nl * 1.6)))); Lw = nl } }
    Ws = Lw + (south.length ? T + rowW(south) : 0)
    let surplus = Ws - Wn
    const cap = (c: Cell) => (c.id === "master" ? 5000 : c.kind === "bedroom" ? 4200 : c.kind === "bath" ? Math.max(1700, Math.min(2400, 8.5e6 / Dn)) : 2200)
    for (let pass = 0; pass < 3 && surplus > 10; pass++) {
      const grow = north.filter((c) => c.w < cap(c))
      if (!grow.length) break
      const each = surplus / grow.length
      for (const c of grow) { const add = r10(Math.min(each, cap(c) - c.w)); c.w += add; surplus -= add }
    }
    if (surplus >= 1000 && !storage) {
      const sw = Math.min(2200, surplus - T)
      north.push({ id: "storage", name: "儲藏室", kind: "storage", w: sw }); storage = true
      surplus -= sw + T
    }
    if (surplus > 10) Lw += surplus // 剩下的給客餐廳
  }
  // 客餐廳長寬比上限 2.6：太扁就加深
  if (Lw / Ds > 2.6) Ds = r10(Math.min(DsMax(), Lw / 2.6))
  const W = Math.max(rowW(north), Lw + (south.length ? T + rowW(south) : 0))
  const py0 = Dn + T, D = py0 + Ds

  const segs: Seg[] = []
  const wall = (s: Omit<Seg, "holes">) => { const x = { ...s, holes: [] as [number, number][] }; segs.push(x); return x }
  const northW = wall({ horiz: true, across: [-EXT, 0], along: [-EXT, W + EXT], kind: "e" })
  const southW = wall({ horiz: true, across: [D, D + EXT], along: [-EXT, W + EXT], kind: "e" })
  const westW = wall({ horiz: false, across: [-EXT, 0], along: [0, D], kind: "e" })
  const eastW = wall({ horiz: false, across: [W, W + EXT], along: [0, D], kind: "e" })
  const mid = wall({ horiz: true, across: [Dn, Dn + T], along: [0, W], kind: "n" })

  const windowOpenings: OpeningRect[] = [], swingDoors: SwingDoor[] = [], slidingDoors: SlidingDoor[] = [], planRooms: PlanRoom[] = []
  const kinds: Record<string, RoomKind> = {}, zones: Record<string, Rect> = {}
  const addRoom = (id: string, name: string, kind: RoomKind, poly: [number, number][], mat: string, zone: Rect) => {
    planRooms.push({ id, name, poly, mat, at: [r10((zone[0] + zone[2]) / 2), r10((zone[1] + zone[3]) / 2)], ...(kind === "balcony" ? { counted: false } : {}) }); kinds[id] = kind; zones[id] = zone
  }
  const hWin = (s: Seg, a: number, b: number) => { s.holes.push([a, b]); windowOpenings.push([a, s.across[0], b, s.across[1]]) }
  const vWin = (s: Seg, a: number, b: number) => { s.holes.push([a, b]); windowOpenings.push([s.across[0], a, s.across[1], b]) }
  const winLen = (k: RoomKind, w: number) => (k === "bath" ? 600 : k === "kitchen" ? 900 : r10(Math.min(2400, Math.max(900, w * 0.5))))
  const mat = (k: RoomKind) => (k === "bath" ? "antislip" : k === "kitchen" ? "tile600" : k === "storage" ? "tile600" : "wood")

  // ---- 北帶 ----
  let x = 0
  north.forEach((c, i) => {
    if (i > 0) { wall({ horiz: false, across: [x, x + T], along: [0, Dn], kind: "n" }); x += T }
    let bx0 = x
    if (c.ensuite) {
      const ex1 = x + c.ensuite
      addRoom("mbath", "主臥衛浴", "bath", rect(x, 0, ex1, Dn), "antislip", [x, 0, ex1, Dn])
      vWin(westW, r10(Dn / 2 - 300), r10(Dn / 2 + 300))
      const ew = wall({ horiz: false, across: [ex1, ex1 + T], along: [0, Dn], kind: "n" })
      const dy = Dn - 150 - 750
      ew.holes.push([dy, dy + 750])
      swingDoors.push({ name: "主臥衛浴門", rect: [ex1, dy, ex1 + T, dy + 750], h: [ex1, dy + 750], c: [0, -1], o: [-1, 0], len: 750 })
      bx0 = ex1 + T
    }
    const x1 = bx0 + c.w
    addRoom(c.id, c.name, c.kind, rect(bx0, 0, x1, Dn), mat(c.kind), [bx0, 0, x1, Dn])
    if (c.kind !== "storage") { const wl = winLen(c.kind, c.w), wc = r10((bx0 + x1) / 2); hWin(northW, wc - wl / 2, wc + wl / 2) }
    if (i === 0 && !c.ensuite) vWin(westW, r10(Dn / 2 - 600), r10(Dn / 2 + 600))
    const len = c.kind === "bedroom" ? 900 : c.kind === "storage" ? 700 : 800
    const dx0 = i === 0 ? x1 - 150 - len : bx0 + 150
    mid.holes.push([dx0, dx0 + len])
    swingDoors.push({ name: `${c.name}門`, rect: [dx0, Dn, dx0 + len, Dn + T], h: i === 0 ? [dx0 + len, Dn] : [dx0, Dn], c: i === 0 ? [-1, 0] : [1, 0], o: [0, -1], len })
    x = x1
  })
  // 北排最後一格延伸到 W（四捨五入誤差）
  if (x < W) { const last = planRooms[planRooms.length - 1]; last.poly = rect(last.poly[0][0], 0, W, Dn); zones[last.id] = [last.poly[0][0], 0, W, Dn] }

  // ---- 南帶 ----
  const hallY = py0 + Hw
  let kitchenZone: Rect | null = null
  if (south.length) {
    const vw = wall({ horiz: false, across: [Lw, Lw + T], along: [hallY, D], kind: "n" }); void vw
    const hw = wall({ horiz: true, across: [hallY, hallY + T], along: [Lw + T, W], kind: "n" })
    let sx = Lw + T
    south.forEach((c, i) => {
      if (i > 0) { wall({ horiz: false, across: [sx, sx + T], along: [hallY + T, D], kind: "n" }); sx += T }
      const y0 = hallY + T
      const x1 = i === south.length - 1 ? W : sx + c.w
      void y0
      addRoom(c.id, c.name, c.kind, rect(sx, y0, x1, D), mat(c.kind), [sx, y0, x1, D])
      if (c.kind === "kitchen") kitchenZone = [sx, y0, x1, D]
      const wl = winLen(c.kind, x1 - sx), wc = r10((sx + x1) / 2)
      hWin(southW, wc - wl / 2, wc + wl / 2)
      const len = c.kind === "bedroom" ? 900 : 800, dx0 = sx + 150
      hw.holes.push([dx0, dx0 + len])
      swingDoors.push({ name: `${c.name}門`, rect: [dx0, hallY, dx0 + len, hallY + T], h: [dx0, hallY + T], c: [1, 0], o: [0, 1], len })
      sx = x1
    })
    addRoom("living", cfg.livings === 2 ? "客廳／餐廳" : "客餐廳", "living",
      [[0, py0], [W, py0], [W, hallY], [Lw, hallY], [Lw, D], [0, D]], "tile800", [0, py0, Lw, D])
  } else addRoom("living", cfg.livings === 2 ? "客廳／餐廳" : "客餐廳", "living", rect(0, py0, W, D), "tile800", [0, py0, W, D])
  const LwEff = south.length ? Lw : W

  // 工作陽台（獨立廚房在南帶最東；廚房→陽台用門，向外開）
  if (kitchenZone) {
    const kz = kitchenZone as Rect
    const bx0 = W + EXT, bx1 = W + EXT + 1300, by0 = kz[1], by1 = D + 100
    wall({ horiz: true, across: [by0 - 100, by0], along: [bx0, bx1 + 100], kind: "low" })
    wall({ horiz: false, across: [bx1, bx1 + 100], along: [by0 - 100, D + EXT], kind: "low" })
    wall({ horiz: true, across: [by1, by1 + 100], along: [bx0, bx1], kind: "low" })
    addRoom("svcbalcony", "工作陽台", "balcony", rect(bx0, by0, bx1, by1), "antislip", [bx0, by0, bx1, by1])
    const sdy = D - 200 - 800
    eastW.holes.push([sdy, sdy + 800])
    swingDoors.push({ name: "工作陽台門", rect: [W, sdy, W + EXT, sdy + 800], h: [W + EXT, sdy], c: [0, 1], o: [1, 0], len: 800 })
  }
  let openKitchenZone: Rect | null = null
  if (cfg.kitchen === "open") {
    openKitchenZone = [r10(LwEff - 2300), py0 + 1000, LwEff, D]
    if (!south.length) { const wc = r10(py0 + Ds / 2); vWin(eastW, wc - 700, wc + 700) }
  }

  // 休閒陽台（客餐廳→陽台＝落地窗，靠陽台東端）
  const bx0 = 400, bx1 = south.length ? LwEff : r10(W - 600), by0 = D + EXT, by1 = D + EXT + 1500
  wall({ horiz: true, across: [by1, by1 + 100], along: [bx0 - 100, bx1 + 100], kind: "low" })
  wall({ horiz: false, across: [bx0 - 100, bx0], along: [by0, by1], kind: "low" })
  wall({ horiz: false, across: [bx1, bx1 + 100], along: [by0, by1], kind: "low" })
  addRoom("balcony", kitchenZone ? "陽台" : "陽台（可曬衣）", "balcony", rect(bx0, by0, bx1, by1), "walnut", [bx0, by0, bx1, by1])
  const sl = r10(Math.min(2400, bx1 - bx0 - 600)), sc = r10(Math.max((bx0 + bx1) / 2, bx1 - 400 - sl / 2))
  southW.holes.push([sc - sl / 2, sc + sl / 2])
  slidingDoors.push({ rect: [sc - sl / 2, D, sc + sl / 2, D + EXT], v: false })

  // 大門（西外牆靠走道端，向內開）
  const ey0 = py0 + 150
  westW.holes.push([ey0, ey0 + 1000])
  swingDoors.push({ name: "大門", rect: [-EXT, ey0, 0, ey0 + 1000], h: [0, ey0], c: [0, 1], o: [1, 0], len: 1000, entry: true })

  // 2 廳：客廳區／餐廳區（同一開放空間，只做分區標示）
  const lz: Rect = [0, py0 + 1000, openKitchenZone ? openKitchenZone[0] - 100 : LwEff, D]
  const split = r10(lz[0] + Math.min(5200, Math.max(3600, (lz[2] - lz[0]) * 0.55)))
  const livingAreas = cfg.livings === 2 && lz[2] - split >= 2200
    ? [{ name: "客廳區", rect: [lz[0], lz[1], split, lz[3]] as Rect }, { name: "餐廳區", rect: [split, lz[1], lz[2], lz[3]] as Rect }]
    : []

  const net = planRooms.filter((r) => kinds[r.id] !== "balcony").reduce((s, r) => s + polyArea(r.poly), 0)
  const bal = planRooms.filter((r) => kinds[r.id] === "balcony").reduce((s, r) => s + polyArea(r.poly), 0)
  const maxX = W + EXT + (kitchenZone ? 1400 : 0)
  const blueprint: PlanBlueprint = {
    id: `gen-${cfg.bedrooms}r${cfg.livings}l${cfg.baths}b-${cfg.kitchen}-${cfg.seed}-${Math.round(cfg.ping * 10)}`,
    name: `${cfg.bedrooms}房${cfg.livings}廳${cfg.baths}衛 · 系統配置`,
    source: "generated",
    walls: cutSegs(segs), windowOpenings, swingDoors, slidingDoors, planRooms,
    bounds: { x: -EXT - 2800, y: -EXT - 1500, w: maxX + 2 * EXT + 4300, h: by1 + 3400 },
    origin: { ox: r10(W / 2), oy: r10(D / 2) },
    notes: [`系統配置 seed=${cfg.seed}，室內淨面積約 ${(net / 1e6 / SQM_PER_PING).toFixed(1)} 坪（不含陽台）`],
  }
  const rooms: Record<string, { name: string; mat: string }> = {}
  planRooms.forEach((r) => (rooms[r.id] = { name: r.name, mat: r.mat }))
  return {
    config: cfg, blueprint, scheme: { furniture: [], rooms, demolished: [], measures: [] }, kinds,
    spawn: { at: [-EXT - 1500, ey0 + 500], lookAt: [1500, ey0 + 500] },
    zones, openKitchenZone, livingAreas, corridorY: py0 + 1000, entrySide: "W",
    areaPing: Math.round((net / 1e6 / SQM_PER_PING) * 10) / 10,
    balconyPing: Math.round((bal / 1e6 / SQM_PER_PING) * 10) / 10,
    variant: { flip: v.flip, ensuite: v.ensuite, bathsSouth: v.bathsSouth, movedBedrooms, storage, source: "procedural" },
  }
}

/** 左右鏡像（x → W - x）。 */
function flipX(g: GeneratedLayout, W: number): GeneratedLayout {
  const fx = (x: number) => W - x
  const fr = <T extends number[]>(r: T): T => { const o = [...r] as T; o[0] = fx(r[2]); o[2] = fx(r[0]); return o }
  const bp = g.blueprint
  bp.walls = bp.walls.map((w) => [fx(w[2]), w[1], fx(w[0]), w[3], w[4]])
  bp.windowOpenings = bp.windowOpenings.map((r) => fr(r))
  bp.slidingDoors = bp.slidingDoors.map((s) => ({ ...s, rect: fr(s.rect) }))
  bp.swingDoors = bp.swingDoors.map((d) => ({ ...d, rect: fr(d.rect), h: [fx(d.h[0]), d.h[1]], c: [-d.c[0], d.c[1]], o: [-d.o[0], d.o[1]] }))
  bp.planRooms = bp.planRooms.map((r) => ({ ...r, poly: r.poly.map(([x, y]) => [fx(x), y] as [number, number]).reverse(), at: r.at ? [fx(r.at[0]), r.at[1]] : undefined }))
  bp.bounds = { ...bp.bounds, x: fx(bp.bounds.x + bp.bounds.w) }
  bp.origin = { ox: fx(bp.origin.ox), oy: bp.origin.oy }
  for (const k of Object.keys(g.zones)) g.zones[k] = fr(g.zones[k])
  if (g.openKitchenZone) g.openKitchenZone = fr(g.openKitchenZone)
  g.livingAreas = g.livingAreas.map((a) => ({ ...a, rect: fr(a.rect) }))
  g.spawn = { at: [fx(g.spawn.at[0]), g.spawn.at[1]], lookAt: [fx(g.spawn.lookAt[0]), g.spawn.lookAt[1]] }
  g.entrySide = "E"
  return g
}

const netPing = (g: GeneratedLayout) => g.areaPing
const variantsFor = (cfg: Required<LayoutConfig>): Variant[] => {
  const vs: Variant[] = []
  for (const ensuite of cfg.baths >= 2 ? [false, true] : [false]) for (const bathsSouth of [false, true])
    vs.push({ flip: false, ensuite, bathsSouth, movedBedrooms: 0, storage: false, jit: 0 })
  return vs
}

const G_STEPS = Array.from({ length: 21 }, (_, i) => i / 20)
/** 某變體在哪段 g 內產出的戶型能通過驗證（不含預算），回傳 [gLo, gHi] 與對應坪數。 */
function validSpan(cfg: Required<LayoutConfig>, v: Variant): { g: [number, number]; ping: [number, number] } | null {
  const ok = G_STEPS.filter((g) => validateLayout(build(cfg, v, g), { budget: false }).length === 0)
  if (!ok.length) return null
  // 取最長的連續區段
  let best: [number, number] = [ok[0], ok[0]], cur: [number, number] = [ok[0], ok[0]]
  for (let i = 1; i < ok.length; i++) {
    if (Math.abs(ok[i] - ok[i - 1] - 0.05) < 1e-9) cur[1] = ok[i]; else cur = [ok[i], ok[i]]
    if (cur[1] - cur[0] > best[1] - best[0]) best = [...cur] as [number, number]
  }
  return { g: best, ping: [netPing(build(cfg, v, best[0])), netPing(build(cfg, v, best[1]))] }
}
const spanCache = new Map<string, ReturnType<typeof validSpan>>()
function spanOf(cfg: Required<LayoutConfig>, v: Variant) {
  const k = JSON.stringify([cfg.bedrooms, cfg.livings, cfg.baths, cfg.kitchen, v.ensuite, v.bathsSouth, v.jit])
  if (!spanCache.has(k)) spanCache.set(k, validSpan(cfg, v))
  return spanCache.get(k)!
}

/** 程序化 fallback 的可行坪數範圍。 */
export function procRange(input: Partial<LayoutConfig>): [number, number] {
  const cfg = normalizeConfig({ ...input, ping: 30 })
  const spans = variantsFor(cfg).map((v) => spanOf(cfg, v)).filter((x) => x) as { ping: [number, number] }[]
  if (!spans.length) return [0, 0]
  return [Math.ceil(Math.min(...spans.map((s) => s.ping[0]))), Math.floor(Math.min(PING_ABS_MAX, Math.max(...spans.map((s) => s.ping[1]))))]
}

/** 符合組合的範本與其可行坪數段。 */
export function templateCandidates(input: Partial<LayoutConfig>): { t: Template; span: [number, number] }[] {
  const cfg = normalizeConfig({ ...input, ping: 30 })
  return TEMPLATES.filter((t) => templateFits(t, cfg)).map((t) => ({ t, span: templateSpan(t, cfg) })).filter((x) => x.span) as { t: Template; span: [number, number] }[]
}

/** 此組合（房／廳／衛／廚）可行的坪數範圍：範本與程序化 fallback 的聯集外框（兩者都連續且重疊時即無缺口；測試會檢查）。 */
export function feasibleRange(input: Partial<LayoutConfig>): [number, number] {
  const spans = [procRange(input), ...templateCandidates(input).map((x) => x.span)].filter((r) => r[1] >= r[0] && r[1] > 0)
  if (!spans.length) return [0, 0]
  // 只取與第一段（程序化，沒有時取第一個範本）相連的聯集：中間有缺口的孤立範本段不算進範圍（避免「範圍內做不出來」）
  let [lo, hi] = spans[0]
  for (let grew = true; grew; ) {
    grew = false
    for (const [a, b] of spans) if (a <= hi + 1 && b >= lo - 1 && (a < lo || b > hi)) { lo = Math.min(lo, a); hi = Math.max(hi, b); grew = true }
  }
  return [lo, Math.min(PING_ABS_MAX, hi)]
}

export function defaultPing(cfg: Omit<Required<LayoutConfig>, "ping">): number {
  const [lo, hi] = feasibleRange({ ...cfg, ping: 30 } as LayoutConfig)
  // 常見坪數（約 10 + 7×房 + 3×衛）夾在可行範圍內；範圍放寬到含範本後，舊的「下限 +20%」會給出偏小的預設（如 2 房 16 坪）
  return Math.max(lo, Math.min(hi, 10 + 7 * cfg.bedrooms + 3 * cfg.baths))
}

export function generateLayout(input: Partial<LayoutConfig>): GeneratedLayout {
  const cfg = normalizeConfig(input)
  const [lo, hi] = feasibleRange(cfg)
  const label = `${cfg.bedrooms}房${cfg.livings}廳${cfg.baths}衛（${cfg.kitchen === "closed" ? "獨立廚房" : "開放廚房"}）`
  if (cfg.ping < lo) throw new BudgetError(`${label}至少需要約 ${lo} 坪，目前選 ${cfg.ping} 坪放不下`, [lo, hi])
  if (cfg.ping > hi) throw new BudgetError(`${label}最多約 ${hi} 坪；更大的坪數請增加房間數`, [lo, hi])
  // 1) 範本優先：符合組合且坪數在其可行段內的範本 × 8 種變換，依 seed 輪替（「換一個」會輪到下一個範本／變換）
  const cands = templateCandidates(cfg).filter((x) => cfg.ping >= x.span[0] && cfg.ping <= x.span[1])
  if (cands.length) {
    const list = Array.from({ length: 8 }, (_, tf) => cands.map((x) => ({ t: x.t, tf }))).flat()
    for (let k = 0; k < list.length; k++) {
      const { t, tf } = list[(cfg.seed - 1 + k) % list.length]
      const g = instantiate(t, cfg, tf)
      // 家具閘門：範本格局合法、擺得下必要家具、且以遊戲碰撞模型全部走得到（先調門的開法），否則換下一個，最後才程序化
      if (validateLayout(g).length === 0 && furnishOk(polishDoors(g))) return spawnNearEntry(g)
    }
  }
  // 2) 程序化 fallback（沒有可用範本時；結果 variant.source = "procedural"，notes 註明）
  const pr = procRange(cfg)
  if (cfg.ping < pr[0] || cfg.ping > pr[1]) throw new BudgetError(`${label}在 ${cfg.ping} 坪找不到合理格局，請調整坪數（可做 ${lo}–${hi} 坪，中間可能有缺口）`, [lo, hi])
  const g = spawnNearEntry(polishDoors(procedural(cfg)))
  g.blueprint.notes = [...(g.blueprint.notes ?? []), cands.length ? "程序化 fallback：範本在此坪數都未通過驗證" : "程序化 fallback：沒有符合此組合的範本"]
  return g
}

/** 出生點固定在大門外 1.1 m（門中心起算），一出生就在 E 的操作距離 1.6 m 內。 */
export function spawnNearEntry(g: GeneratedLayout): GeneratedLayout {
  const d = g.blueprint.swingDoors.find((x) => x.entry)
  if (!d) return g
  const r = d.rect, c: [number, number] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], horiz = r[2] - r[0] >= r[3] - r[1]
  const s = horiz ? Math.sign(g.spawn.at[1] - c[1]) || 1 : Math.sign(g.spawn.at[0] - c[0]) || 1
  g.spawn = horiz ? { at: [c[0], c[1] + s * 1100], lookAt: [c[0], c[1] - s * 1500] } : { at: [c[0] + s * 1100, c[1]], lookAt: [c[0] - s * 1500, c[1]] }
  return g
}
const furnishOk = (g: GeneratedLayout) => validateLayout(g).length === 0 && validateFurniture(g, autoFurnish(g).items).length === 0

function procedural(cfg: Required<LayoutConfig>): GeneratedLayout {
  const [lo, hi] = procRange(cfg)
  const label = `${cfg.bedrooms}房${cfg.livings}廳${cfg.baths}衛`
  // 依 seed 選變體；若該變體做不到這個坪數，依序換下一個可行變體
  const v0 = variantOf(cfg)
  const all = variantsFor(cfg)
  const start = all.findIndex((x) => x.ensuite === v0.ensuite && x.bathsSouth === v0.bathsSouth)
  let v: Variant | null = null, span: { g: [number, number] } | null = null
  for (let k = 0; k < all.length; k++) {
    const cand = { ...all[(start + k) % all.length], flip: v0.flip, jit: 0 }
    const sp = spanOf(cfg, cand)
    if (sp && cfg.ping >= sp.ping[0] - 0.5 && cfg.ping <= sp.ping[1] + 0.5) { v = cand; span = sp; break }
  }
  if (!v || !span) throw new BudgetError(`${label}在 ${cfg.ping} 坪找不到合理格局，請調整坪數`, [lo, hi])
  let a = span.g[0], b = span.g[1], best = build(cfg, v, a)
  for (let i = 0; i < 20; i++) {
    const m = (a + b) / 2, gm = build(cfg, v, m)
    if (Math.abs(netPing(gm) - cfg.ping) < Math.abs(netPing(best) - cfg.ping)) best = gm
    if (netPing(gm) < cfg.ping) a = m; else b = m
  }
  const gb = build(cfg, v, span.g[1])
  if (Math.abs(netPing(gb) - cfg.ping) < Math.abs(netPing(best) - cfg.ping)) best = gb
  if (v.flip) {
    const W = Math.max(...best.blueprint.walls.filter((w) => w[4] === "e").map((w) => w[2])) - EXT
    flipX(best, W)
  }
  return best
}

/** 「換一個」：找下一個與目前幾何不同的 seed（最多試 50 個）。 */
export function nextDistinctSeed(cfg: Required<LayoutConfig>, current: GeneratedLayout): number {
  const sig = (g: GeneratedLayout) => JSON.stringify([g.blueprint.walls, g.blueprint.swingDoors.map((d) => d.rect), g.blueprint.windowOpenings])
  const cur = sig(current)
  for (let s = cfg.seed + 1; s <= cfg.seed + 50; s++) {
    try { if (sig(generateLayout({ ...cfg, seed: s })) !== cur) return s } catch { /* 跳過 */ }
  }
  return cfg.seed + 1
}
