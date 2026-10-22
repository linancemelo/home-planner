/** 產生戶型驗證：可達性、大門在外牆、陽台規則、房間不重疊、開口在牆上、出生點不卡牆。 */
import type { OpeningRect, WallRect } from "../../plan/types/blueprint.ts"
import type { GeneratedLayout, RoomKind } from "./types.ts"
import { polyArea } from "./generateLayout.ts"

type P = [number, number]

export function pointInPoly([x, y]: P, poly: P[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}


/** 點到多邊形的距離（在內部為 0）。 */
export function distToPoly(p: P, poly: P[]): number {
  if (pointInPoly(p, poly)) return 0
  let d = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L))
    d = Math.min(d, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy))
  }
  return d
}
/** 牆片上離所有房間超過 300 mm（從牆面算）的取樣點數。 */
export function danglingWallPoints(walls: readonly (readonly unknown[])[], polys: P[][]): { wall: number; at: P }[] {
  const out: { wall: number; at: P }[] = []
  walls.forEach((w, i) => {
    if (w[4] === "low") return
    const [x0, y0, x1, y1] = w as number[], horiz = x1 - x0 >= y1 - y0, th = horiz ? y1 - y0 : x1 - x0
    const L = horiz ? x1 - x0 : y1 - y0, n = Math.max(1, Math.ceil(L / 200))
    for (let k = 0; k <= n; k++) {
      const u = (horiz ? x0 : y0) + (L * k) / n, p: P = horiz ? [u, (y0 + y1) / 2] : [(x0 + x1) / 2, u]
      if (polys.every((poly) => distToPoly(p, poly) > th / 2 + 300)) { out.push({ wall: i, at: p }); break }
    }
  })
  return out
}
const inRect = ([x, y]: P, r: readonly unknown[], m = 0) => x > (r[0] as number) - m && x < (r[2] as number) + m && y > (r[1] as number) - m && y < (r[3] as number) + m

export type Connection = { a: string | null; b: string | null; type: "swing" | "slide"; name: string; entry: boolean }

export function connectionsOf(g: GeneratedLayout): Connection[] {
  const bp = g.blueprint
  const roomAt = (p: P) => bp.planRooms.find((r) => pointInPoly(p, r.poly))?.id ?? null
  const sides = (r: OpeningRect): [string | null, string | null] => {
    const [x0, y0, x1, y1] = r
    const horizWall = x1 - x0 > y1 - y0
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    return horizWall ? [roomAt([cx, y0 - 300]), roomAt([cx, y1 + 300])] : [roomAt([x0 - 300, cy]), roomAt([x1 + 300, cy])]
  }
  return [
    ...bp.swingDoors.map((d) => { const [a, b] = sides(d.rect); return { a, b, type: "swing" as const, name: d.name, entry: !!d.entry } }),
    ...bp.slidingDoors.map((d, i) => { const [a, b] = sides(d.rect); return { a, b, type: "slide" as const, name: `落地窗${i + 1}`, entry: false } }),
  ]
}

/** 各房型面積（m²）與長寬比上限。 */
export const ROOM_LIMITS: Record<string, { min: number; max: number; aspect: number }> = {
  master: { min: 9, max: 26, aspect: 2.0 },
  bedroom: { min: 7, max: 22, aspect: 2.0 },
  bath: { min: 2.5, max: 9, aspect: 2.6 },
  kitchen: { min: 4, max: 14, aspect: 2.5 },
  storage: { min: 1.5, max: 9, aspect: 3.0 },
  study: { min: 4, max: 18, aspect: 2.4 },
  living: { min: 18, max: 95, aspect: 3.0 },
}
export const BUDGET_TOL = 0.12

export function validateLayout(g: GeneratedLayout, o: { budget?: boolean } = {}): string[] {
  const errs: string[] = []
  const cfg = g.config
  // 預算：室內淨面積（不含陽台）在要求 ±12% 內
  const netPing = g.blueprint.planRooms.filter((r) => g.kinds[r.id] !== "balcony" && g.kinds[r.id] !== "hall").reduce((s, r) => s + polyArea(r.poly), 0) / 1e6 / 3.305785
  if (o.budget !== false && Math.abs(netPing - cfg.ping) > cfg.ping * BUDGET_TOL) errs.push(`室內 ${netPing.toFixed(1)} 坪超出預算 ${cfg.ping} 坪 ±12%`)
  if (Math.abs(netPing - g.areaPing) > 0.2) errs.push("面積標示與實際不符")
  // 房數、衛浴數
  const cnt = (k: string) => Object.values(g.kinds).filter((x) => x === k).length
  if (cnt("bedroom") !== cfg.bedrooms) errs.push(`臥室 ${cnt("bedroom")} 間，應為 ${cfg.bedrooms}`)
  if (cnt("bath") !== cfg.baths) errs.push(`衛浴 ${cnt("bath")} 間，應為 ${cfg.baths}`)
  if ((cnt("kitchen") === 1) !== (cfg.kitchen === "closed")) errs.push("廚房形式與設定不符")
  // 面積／長寬比
  for (const r of g.blueprint.planRooms) {
    const k = g.kinds[r.id]
    if (k === "balcony" || k === "hall") continue // 走廊（範本的走道）不套房間尺寸規則
    const lim = ROOM_LIMITS[r.id === "master" ? "master" : k]
    const z = g.zones[r.id], zw = (z[2] - z[0]) / 1000, zd = (z[3] - z[1]) / 1000
    const a = polyArea(r.poly) / 1e6, asp = Math.max(zw, zd) / Math.min(zw, zd)
    if (a > lim.max) errs.push(`${r.name} ${a.toFixed(1)} m² 超過上限 ${lim.max}`)
    if (asp > lim.aspect) errs.push(`${r.name} 長寬比 ${asp.toFixed(2)} 超過 ${lim.aspect}`)
    // L 形等非矩形：用整體「長邊² / 面積」當等效長寬比，避免細長的臂躲過外框檢查
    const eq = Math.max(zw, zd) ** 2 / a
    if (k === "living" && eq > lim.aspect * 1.25) errs.push(`${r.name} 整體形狀太細長（長邊²/面積 ${eq.toFixed(2)}）`)
    if ((k === "bedroom") && Math.min(zw, zd) < 2.6) errs.push(`${r.name} 短邊 ${Math.min(zw, zd).toFixed(2)} m 小於 2.6 m`)
  }
  const bp = g.blueprint
  const kind = (id: string | null): RoomKind | null => (id ? g.kinds[id] ?? null : null)
  const conns = connectionsOf(g)

  // 大門
  const entries = conns.filter((c) => c.entry)
  if (entries.length !== 1) errs.push(`大門數量應為 1，實際 ${entries.length}`)
  const entry = entries[0]
  let start: string | null = null
  if (entry) {
    const start = entry.a ?? entry.b
    if (kind(start) !== "living") errs.push("大門應通往客餐廳")
  }
  for (const c of conns) {
    if (c.a === null && c.b === null) errs.push(`${c.name} 兩側都不是房間`)
    if (c.a && c.a === c.b) errs.push(`${c.name} 兩側同一房間`)
  }
  // 可達性（幾何洪水填充，可經過未標示的走道）：門全開時每間都走得到；大門關著時進不了室內
  {
    const entryRect = bp.swingDoors.find((d) => d.entry)?.rect
    const all = flood(g, null), closed = entryRect ? flood(g, entryRect) : null
    for (const r of bp.planRooms) if (!all.has(r.id)) errs.push(`${r.name} 從大門無法到達`)
    if (closed) for (const id of closed) if (kind(id) !== "balcony") { errs.push(`大門關著仍可進入 ${id}（大門不在外牆上）`); break }
  }

  // 一定要有曬衣／工作陽台
  if (!bp.planRooms.some((r) => kind(r.id) === "balcony" && /工作陽台|曬衣/.test(r.name))) errs.push("缺少曬衣／工作陽台")
  // 懸空牆：牆片離所有房間 > 0.3 m
  for (const d of danglingWallPoints(bp.walls, [...bp.planRooms.map((r) => r.poly as P[]), ...(g.halls ?? [])])) errs.push(`牆片 ${d.wall} 懸空在房子外（${Math.round(d.at[0])},${Math.round(d.at[1])}）`)
  // 落地窗最小寬度 1.8 m
  for (const [i, d] of bp.slidingDoors.entries()) {
    const w = Math.max(d.rect[2] - d.rect[0], d.rect[3] - d.rect[1])
    if (w < 1800) errs.push(`落地窗${i + 1} 寬 ${Math.round(w)} mm 小於 1800`)
  }
  // 曬衣陽台：獨立工作陽台 ≥ 2 m²；與客廳共用的「陽台（可曬衣）」需 ≥ 3 m² 且短邊 ≥ 1.5 m
  for (const r of bp.planRooms.filter((r) => /（可曬衣）/.test(r.name))) {
    const z = g.zones[r.id], a = polyArea(r.poly) / 1e6, sd = Math.min(z[2] - z[0], z[3] - z[1])
    if (a < 3 || sd < 1500) errs.push(`共用曬衣陽台太小（${a.toFixed(1)} m²、短邊 ${(sd / 1000).toFixed(2)} m；需 ≥ 3 m²、≥ 1.5 m）`)
  }
  // 門寬合理
  for (const d of bp.swingDoors) {
    const [lo, hi] = d.entry ? [850, 1300] : [600, 1200]
    if (d.len < lo || d.len > hi) errs.push(`${d.name} 門寬 ${Math.round(d.len)} mm 不在 ${lo}–${hi}`)
  }
  // 陽台規則
  for (const c of conns) {
    if (!c.a || !c.b) continue
    const ks = [kind(c.a), kind(c.b)]
    if (!ks.includes("balcony")) { if (c.type === "slide") errs.push(`${c.name} 落地窗只能用在客廳通陽台`); continue }
    const other = ks[0] === "balcony" ? ks[1] : ks[0]
    if (other === "living" && c.type !== "slide") errs.push(`客廳通陽台必須用落地窗（${c.name}）`)
    if ((other === "bedroom" || other === "kitchen") && c.type !== "swing") errs.push(`臥室/廚房通陽台必須用門（${c.name}）`)
  }

  // 房間面積、不重疊
  for (const r of bp.planRooms) {
    const a = polyArea(r.poly) / 1e6, k = kind(r.id)
    if (k === "hall") continue
    const min = k === "balcony" ? 2 : ROOM_LIMITS[r.id === "master" ? "master" : k!].min
    if (a < min) errs.push(`${r.name} 面積 ${a.toFixed(1)} m² 小於 ${min}`)
  }
  const xs = bp.planRooms.flatMap((r) => r.poly.map((p) => p[0])), ys = bp.planRooms.flatMap((r) => r.poly.map((p) => p[1]))
  for (let x = Math.min(...xs) + 50; x < Math.max(...xs); x += 200)
    for (let y = Math.min(...ys) + 50; y < Math.max(...ys); y += 200) {
      const n = bp.planRooms.filter((r) => pointInPoly([x, y], r.poly)).length
      if (n > 1) { errs.push(`房間重疊於 (${x},${y})`); x = Infinity; break }
    }

  // 房間不得與牆重疊（取房內點）
  const walls = bp.walls as WallRect[]
  for (const r of bp.planRooms) if (r.at && walls.some((w) => inRect(r.at as P, w))) errs.push(`${r.name} 標記點落在牆內`)

  // 開口必須嵌在牆中（兩端緊鄰牆）且不與牆重疊
  const openings: [string, OpeningRect][] = [
    ...bp.windowOpenings.map((o, i) => [`窗${i + 1}`, o] as [string, OpeningRect]),
    ...bp.swingDoors.map((d) => [d.name, d.rect] as [string, OpeningRect]),
    ...bp.slidingDoors.map((d, i) => [`落地窗${i + 1}`, d.rect] as [string, OpeningRect]),
  ]
  for (const [name, [x0, y0, x1, y1]] of openings) {
    const horiz = x1 - x0 > y1 - y0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    const ends: P[] = horiz ? [[x0 - 20, cy], [x1 + 20, cy]] : [[cx, y0 - 20], [cx, y1 + 20]]
    if (!ends.every((p) => walls.some((w) => inRect(p, w, 1)))) errs.push(`${name} 兩端未接牆`)
    if (walls.some((w) => x0 < w[2] - 1 && x1 > w[0] + 1 && y0 < w[3] - 1 && y1 > w[1] + 1)) errs.push(`${name} 與牆重疊`)
  }

  // 每個非陽台房間都直接有門（或落地窗）
  for (const r of bp.planRooms) {
    if (kind(r.id) === "balcony" || kind(r.id) === "hall") continue // 走廊是開放空間，不需要門
    if (!conns.some((c) => c.a === r.id || c.b === r.id)) errs.push(`${r.name} 沒有門`)
  }
  // 開口彼此不重疊（含門扇擺動區不與其他開口重疊）
  for (let i = 0; i < openings.length; i++) for (let j = i + 1; j < openings.length; j++) {
    const a = openings[i][1], b = openings[j][1]
    if (a[0] < b[2] + 100 && a[2] > b[0] - 100 && a[1] < b[3] + 100 && a[3] > b[1] - 100) errs.push(`${openings[i][0]} 與 ${openings[j][0]} 開口重疊或太近`)
  }
  for (const d of bp.swingDoors) {
    const L = d.len, [hx, hy] = d.h
    const xs = [hx, hx + d.c[0] * L, hx + d.o[0] * L], ys = [hy, hy + d.c[1] * L, hy + d.o[1] * L]
    const sw = [Math.min(...xs) + 5, Math.min(...ys) + 5, Math.max(...xs) - 5, Math.max(...ys) - 5]
    for (const [name, o] of openings) {
      if (name === d.name) continue
      if (sw[0] < o[2] && sw[2] > o[0] && sw[1] < o[3] && sw[3] > o[1]) errs.push(`${d.name} 門扇擺動區壓到 ${name}`)
    }
    if (walls.some((w) => sw[0] < w[2] && sw[2] > w[0] && sw[1] < w[3] && sw[3] > w[1])) errs.push(`${d.name} 門扇擺動會撞牆`)
  }
  // 獨立廚房需有窗
  const hasWinIn = (r: { poly: P[] }) => bp.windowOpenings.some(([x0, y0, x1, y1]) => {
    const c: P = [(x0 + x1) / 2, (y0 + y1) / 2]
    return [[c[0], c[1] + 300], [c[0], c[1] - 300], [c[0] + 300, c[1]], [c[0] - 300, c[1]]].some((p) => pointInPoly(p as P, r.poly))
  })
  for (const r of bp.planRooms.filter((r) => kind(r.id) === "kitchen")) if (!hasWinIn(r)) errs.push(`${r.name} 沒有窗`)
  // 每間臥室需有窗
  for (const r of bp.planRooms.filter((r) => kind(r.id) === "bedroom")) {
    const hasWin = bp.windowOpenings.some(([x0, y0, x1, y1]) => {
      const c: P = [(x0 + x1) / 2, (y0 + y1) / 2]
      return [[c[0], c[1] + 300], [c[0], c[1] - 300], [c[0] + 300, c[1]], [c[0] - 300, c[1]]].some((p) => pointInPoly(p as P, r.poly))
    })
    if (!hasWin) errs.push(`${r.name} 沒有窗`)
  }

  // 出生點：大門外、不卡牆、不在房內
  const s = g.spawn.at
  if (bp.planRooms.some((r) => pointInPoly(s, r.poly))) errs.push("出生點落在室內")
  if (walls.some((w) => inRect(s, w, 400))) errs.push("出生點距牆不足 0.4 m")
  if (entry) {
    const d = bp.swingDoors.find((x) => x.entry)!
    const dc: P = [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2]
    const dist = Math.hypot(s[0] - dc[0], s[1] - dc[1])
    if (dist < 1000 || dist > 2500) errs.push(`出生點距大門 ${Math.round(dist)} mm，應在 1–2.5 m`)
    // 出生點到門之間無牆
    for (let t = 0.05; t < 0.95; t += 0.05) {
      const p: P = [s[0] + (dc[0] - s[0]) * t, s[1] + (dc[1] - s[1]) * t]
      if (walls.some((w) => inRect(p, w))) { errs.push("出生點與大門之間被牆擋住"); break }
    }
  }
  return errs
}

/** 100 mm 格點洪水填充（障礙膨脹 200 mm ≈ 人的半徑）。blockRect：額外視為牆（例如關著的大門）。回傳到得了的房間 id。 */
export function flood(g: GeneratedLayout, blockRect: readonly number[] | null, extra: readonly (readonly number[])[] = []): Set<string> {
  return floodGrid(g, blockRect ? [blockRect, ...extra] : extra).rooms
}

/** 同上，另回傳 reach(p)：某點（mm）是否走得到；extra 為額外障礙（例如家具）。 */
export function floodGrid(g: GeneratedLayout, extra: readonly (readonly number[])[]): { rooms: Set<string>; reach: (p: P) => boolean } {
  const bp = g.blueprint, b = bp.bounds, S = 100, R = 200
  const nx = Math.ceil(b.w / S), nz = Math.ceil(b.h / S)
  const blocked = new Uint8Array(nx * nz)
  const mark = (r: readonly unknown[]) => {
    const x0 = Math.max(0, Math.floor(((r[0] as number) - R - b.x) / S)), x1 = Math.min(nx - 1, Math.ceil(((r[2] as number) + R - b.x) / S))
    const z0 = Math.max(0, Math.floor(((r[1] as number) - R - b.y) / S)), z1 = Math.min(nz - 1, Math.ceil(((r[3] as number) + R - b.y) / S))
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const cx = b.x + x * S, cz = b.y + z * S
      if (cx > (r[0] as number) - R && cx < (r[2] as number) + R && cz > (r[1] as number) - R && cz < (r[3] as number) + R) blocked[z * nx + x] = 1
    }
  }
  bp.walls.forEach(mark); bp.windowOpenings.forEach(mark)
  extra.forEach(mark)
  const sx = Math.round((g.spawn.at[0] - b.x) / S), sz = Math.round((g.spawn.at[1] - b.y) / S)
  const seen = new Uint8Array(nx * nz), q = [sz * nx + sx]
  seen[q[0]] = 1
  while (q.length) {
    const c = q.pop()!, x = c % nx, z = (c / nx) | 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = x + dx, az = z + dz
      if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue
      const k = az * nx + ax
      if (seen[k] || blocked[k]) continue
      seen[k] = 1; q.push(k)
    }
  }
  const out = new Set<string>()
  for (const r of bp.planRooms) {
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1])
    outer: for (let x = Math.min(...xs); x <= Math.max(...xs); x += S) for (let y = Math.min(...ys); y <= Math.max(...ys); y += S) {
      const k = Math.round((y - b.y) / S) * nx + Math.round((x - b.x) / S)
      if (seen[k] && pointInPoly([x, y], r.poly)) { out.add(r.id); break outer }
    }
  }
  const reach = (p: P) => {
    const x = Math.round((p[0] - b.x) / S), z = Math.round((p[1] - b.y) / S)
    return x >= 0 && z >= 0 && x < nx && z < nz && seen[z * nx + x] === 1
  }
  return { rooms: out, reach }
}
