/** 3D 走動測試：出生點在門外且沒卡住；門全關進不了室內；門全開每間房都走得到（含家具碰撞）；沿牆滑動不穿牆。 */
import { generateLayout, feasibleRange } from "../src/game/layout/generateLayout.ts"
import { BudgetError } from "../src/game/layout/types.ts"
import { autoFurnish } from "../src/game/furnish/autoFurnish.ts"
import { blocked, colliders, leafBox, makeInteractables, move, nearest, roomAt, stepBack, type Box } from "../src/game/scene/walk.ts"
import { unreachable } from "../src/game/scene/reach.ts"
import { pointInPoly } from "../src/game/layout/validateLayout.ts"
import type { GeneratedLayout } from "../src/game/layout/types.ts"

function reach(g: GeneratedLayout, boxes: Box[], from: [number, number] = g.spawn.at, to?: [number, number]): Set<string> | boolean {
  const b = g.blueprint.bounds, S = 100, nx = Math.ceil(b.w / S) + 1, nz = Math.ceil(b.h / S) + 1
  const seen = new Uint8Array(nx * nz), q: number[] = []
  const sx = Math.round((from[0] - b.x) / S), sz = Math.round((from[1] - b.y) / S)
  q.push(sz * nx + sx); seen[q[0]] = 1
  while (q.length) {
    const c = q.pop()!, x = c % nx, z = (c / nx) | 0
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ax = x + dx, az = z + dz, k = az * nx + ax
      if (ax < 0 || az < 0 || ax >= nx || az >= nz || seen[k]) continue
      if (blocked(b.x + ax * S, b.y + az * S, boxes)) continue
      seen[k] = 1; q.push(k)
    }
  }
  if (to) return seen[Math.round((to[1] - b.y) / S) * nx + Math.round((to[0] - b.x) / S)] === 1
  const out = new Set<string>()
  for (const r of g.blueprint.planRooms) {
    const xs = r.poly.map((p) => p[0]), ys = r.poly.map((p) => p[1])
    outer: for (let x = Math.min(...xs); x <= Math.max(...xs); x += S) for (let y = Math.min(...ys); y <= Math.max(...ys); y += S) {
      const k = Math.round((y - b.y) / S) * nx + Math.round((x - b.x) / S)
      if (seen[k] && pointInPoly([x, y], r.poly as [number, number][])) { out.add(r.id); break outer }
    }
  }
  return out
}

let n = 0, fail = 0
for (const bedrooms of [1, 2, 3, 4] as const) for (const livings of [1, 2] as const) for (const baths of [1, 2, 3] as const) for (const kitchen of ["open", "closed"] as const) {
  if (baths > bedrooms + 1) continue
  const base = { bedrooms, livings, baths, kitchen }
  let lo: number, hi: number
  try { [lo, hi] = feasibleRange(base) } catch { continue }
  for (const ping of [lo, Math.round((lo + hi) / 2), hi]) for (const seed of [1, 2]) {
    let g
    try { g = generateLayout({ ...base, ping, seed }) } catch (e) { if (e instanceof BudgetError) continue; throw e }
    n++
    const f = autoFurnish(g), st = makeInteractables(g, f.items), errs: string[] = []
    const closed = colliders(g, f.items, st)
    if (blocked(g.spawn.at[0], g.spawn.at[1], closed)) errs.push("出生點卡住")
    if (roomAt(g, g.spawn.at)) errs.push("出生點在室內")
    const inClosed = reach(g, closed) as Set<string>
    if (inClosed.size) errs.push(`門關著能進 ${[...inClosed].join(",")}`)
    // 遊戲碰撞模型（scene/reach.ts，與遊戲、自動家具共用）：從大門內側出發，門片開 90°、家具碰撞盒、r=0.2 m，
    // 每間房與每件設備（洗衣機／馬桶／浴櫃／淋浴／床／衣櫃／冰箱／爐）前方都要走得到（全開，或只關一扇門）
    for (const u of unreachable(g, f.items)) errs.push(`走不到 ${u}`)
    st.forEach((s) => { if (s.kind === "slide") s.open = true })
    const free = colliders(g, f.items, st).filter((_, i) => i < g.blueprint.walls.length + g.blueprint.windowOpenings.length || i >= g.blueprint.walls.length + g.blueprint.windowOpenings.length + g.blueprint.swingDoors.length)
    // 出生點一開始就能按 E 開大門（距離、面向、視線）
    const sp = g.spawn.at, la = g.spawn.lookAt, dl = Math.hypot(la[0] - sp[0], la[1] - sp[1]) || 1
    const first = nearest(makeInteractables(g, f.items), sp, 1600, g, [(la[0] - sp[0]) / dl, (la[1] - sp[1]) / dl])
    if (!(first?.kind === "swing" && g.blueprint.swingDoors[first.i].entry)) errs.push(`出生點按 E 不是大門（${first?.name ?? "沒有東西"}）`)
    // 不能隔牆操作：屋外一圈（離外框 0.4–1.2 m）任何位置、任何朝向，都不能操作冰箱或室內的門
    {
      const b = g.blueprint.bounds, sts = makeInteractables(g, f.items)
      const xs = g.blueprint.walls.map((w) => [w[0], w[2]]).flat(), ys = g.blueprint.walls.map((w) => [w[1], w[3]]).flat()
      const X0 = Math.min(...xs), X1 = Math.max(...xs), Y0 = Math.min(...ys), Y1 = Math.max(...ys)
      outer: for (let x = X0 - 1200; x <= X1 + 1200; x += 300) for (let y = Y0 - 1200; y <= Y1 + 1200; y += 300) {
        if (x > X0 - 400 && x < X1 + 400 && y > Y0 - 400 && y < Y1 + 400) continue
        if (roomAt(g, [x, y]) || blocked(x, y, closed)) continue
        for (const dir of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          const n = nearest(sts, [x, y], 1600, g, dir)
          if (n && (n.kind === "fridge" || (n.kind === "swing" && !g.blueprint.swingDoors[n.i].entry))) { errs.push(`屋外 (${x},${y}) 可以操作 ${n.name}`); break outer }
        }
      }
      void b
    }
    // 自動後退（開門時門片壓到人）：結果一定在同一房間、不被新門片壓到，沿路不穿牆
    g.blueprint.swingDoors.forEach((d, i) => {
      const sts = makeInteractables(g, f.items), before = colliders(g, f.items, sts)
      sts.forEach((s) => { if (s.kind === "swing" && s.i === i) s.open = true })
      const after = colliders(g, f.items, sts), sw = leafBox(d, true)
      for (const p of [[(sw[0] + sw[2]) / 2, (sw[1] + sw[3]) / 2], [sw[0] - 150, sw[1] - 150], [sw[2] + 150, sw[3] + 150]] as [number, number][]) {
        if (blocked(p[0], p[1], before)) continue
        const at: [number, number] = [(d.rect[0] + d.rect[2]) / 2, (d.rect[1] + d.rect[3]) / 2]
        const q = stepBack(g, p, at, before, after)
        if (q && (roomAt(g, q) !== roomAt(g, p) || blocked(q[0], q[1], after))) errs.push(`${d.name} 自動後退跑到 ${roomAt(g, q)}`)
      }
    })
    // 每扇門單獨打開時，門片不能擋住自己的通道（兩側互通）
    g.blueprint.swingDoors.forEach((d) => {
      const r = d.rect, horiz = r[2] - r[0] > r[3] - r[1], cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2
      const a: [number, number] = horiz ? [cx, r[1] - 450] : [r[0] - 450, cy], bb: [number, number] = horiz ? [cx, r[3] + 450] : [r[2] + 450, cy]
      if (blocked(a[0], a[1], free) || blocked(bb[0], bb[1], free)) return
      if (!reach(g, [...free, leafBox(d, true)], a, bb)) errs.push(`${d.name} 打開後門片擋路`)
    })
    // 朝房子中心直走 30 m：不可穿牆（門關著時一定停在室外）
    const c: [number, number] = [g.blueprint.bounds.x + g.blueprint.bounds.w / 2, g.blueprint.bounds.y + g.blueprint.bounds.h / 2]
    let p: [number, number] = [...g.spawn.at]
    for (let i = 0; i < 300; i++) { const d = Math.hypot(c[0] - p[0], c[1] - p[1]) || 1; p = move(p, ((c[0] - p[0]) / d) * 100, ((c[1] - p[1]) / d) * 100, closed) }
    if (roomAt(g, p)) errs.push(`門關著卻走進 ${roomAt(g, p)}`)
    if (errs.length) { fail++; if (fail <= 8) console.log(`FAIL ${bedrooms}房${livings}廳${baths}衛${kitchen} ${ping}坪 s${seed}:`, errs.join("；")) }
  }
}
console.log(`${n} layouts walked, ${fail} failed`)
if (fail) process.exit(1)
console.log("All walk checks passed.")
