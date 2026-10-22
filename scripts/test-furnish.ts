/** 自動家具測試：各組合／坪數／seed 產生戶型→配家具→檢查；並測替換款式。 */
import { generateLayout, feasibleRange } from "../src/game/layout/generateLayout.ts"
import { BudgetError } from "../src/game/layout/types.ts"
import { autoFurnish } from "../src/game/furnish/autoFurnish.ts"
import { validateFurniture } from "../src/game/furnish/validateFurniture.ts"
import { VARIANTS } from "../src/game/furnish/variants.ts"
import { swapItem } from "../src/game/furnish/swap.ts"

let n = 0, fail = 0
const fails: Record<string, number> = {}
const all = process.env.ALL === "1"
for (const bedrooms of [1, 2, 3, 4] as const) for (const livings of [1, 2] as const) for (const baths of [1, 2, 3] as const) for (const kitchen of ["open", "closed"] as const) {
  if (baths > bedrooms + 1) continue
  const base = { bedrooms, livings, baths, kitchen }
  let lo: number, hi: number
  try { [lo, hi] = feasibleRange(base) } catch { continue }
  const pings = all ? Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) : [lo, Math.round((lo + hi) / 2), hi]
  for (const ping of pings) for (const seed of all ? [1, 2, 3, 4] : [1, 2]) {
    let g
    try { g = generateLayout({ ...base, ping, seed }) } catch (e) { if (e instanceof BudgetError) continue; throw e }
    n++
    const f = autoFurnish(g)
    const errs = [...validateFurniture(g, f.items)]
    if (errs.length) {
      fail++
      for (const e of errs) { const k = e.replace(/\(.*?\)/g, "").replace(/\d+/g, "#"); fails[k] = (fails[k] ?? 0) + 1 }
      if (fail <= 8) console.log(`FAIL ${bedrooms}房${livings}廳${baths}衛${kitchen} ${ping}坪 seed${seed} ${g.notes?.[0] ?? ""}:`, errs.slice(0, 4).join("；"), f.missing.length ? `missing:${f.missing.join(",")}` : "")
    }
  }
}
// 替換：每個槽位換成其他款式，仍要合法或回退成可放的款式
const g = generateLayout({ bedrooms: 3, livings: 2, baths: 2, kitchen: "open", ping: 32, seed: 1 })
const base = autoFurnish(g)
let swaps = 0, swapFail = 0, applied = 0
let moved = 0
for (const it of base.items) for (const v of VARIANTS[it.slot]) {
  if (v.id === it.variant) continue
  const next = swapItem(g, base.items, it.id, v.id)
  swaps++
  if (!next) continue
  applied++
  // 只有這一件（電視櫃連同電視）可以動，其他家具位置、款式都不變
  for (const o of base.items) { const m = next.find((x) => x.id === o.id)!; if (o.id !== it.id && !(it.slot === "tvstand" && o.slot === "tv") && JSON.stringify(m) !== JSON.stringify(o)) moved++ }
  const e = validateFurniture(g, next)
  if (e.length) { swapFail++; if (swapFail <= 3) console.log("SWAP FAIL", it.slotKey, v.id, e[0]) }
}
// 電視櫃：放得下 2.4 m 的位置一定放得下 1.5 m
const tvs = base.items.find((i) => i.slot === "tvstand")
if (tvs && tvs.variant === "tv240" && !swapItem(g, base.items, tvs.id, "tv150")) { swapFail++; console.log("SWAP FAIL 電視櫃 2.4m→1.5m 放不下") }
if (moved) { swapFail++; console.log(`SWAP FAIL 替換時動到其他家具 ${moved} 件`) }
console.log(`${n} furnished layouts, ${fail} failed; ${swaps} swaps (${applied} fit), ${swapFail} failed`)
if (fail) console.log(Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 12))
if (fail || swapFail) process.exit(1)
console.log("All furniture checks passed.")
