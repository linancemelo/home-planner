/** 系統配置戶型產生器測試。Usage: npm run test:layout */
import { feasibleRange, generateLayout, nextDistinctSeed } from "../src/game/layout/generateLayout.ts"
import { validateLayout } from "../src/game/layout/validateLayout.ts"
import { BudgetError } from "../src/game/layout/types.ts"
import { TEMPLATES, templateSpan } from "../src/game/layout/templateLayout.ts"
import { normalizeConfig } from "../src/game/layout/generateLayout.ts"
import { readFileSync } from "fs"

let failed = 0, total = 0
const fail = (m: string) => { failed++; if (failed <= 25 || process.env.ALL) console.log("FAIL " + m) }
const ranges: string[] = []
const coverage: string[] = []
for (const bedrooms of [1, 2, 3, 4] as const)
  for (const baths of [1, 2, 3] as const)
    for (const livings of [1, 2] as const)
      for (const kitchen of ["open", "closed"] as const) {
        const base = { bedrooms, baths, livings, kitchen }
        const [lo, hi] = feasibleRange(base)
        ranges.push(`${bedrooms}房${livings}廳${baths}衛${kitchen === "open" ? "開" : "獨"} ${lo}–${hi}`)
        if (!(lo < hi)) { fail(`${JSON.stringify(base)} 範圍無效 ${lo}-${hi}`); continue }
        // 低於下限、高於上限：必須明確丟 BudgetError，不可靜默夾值
        for (const bad of [lo - 1, hi + 1]) {
          try { generateLayout({ ...base, ping: bad, seed: 1 }); fail(`${JSON.stringify(base)} ping=${bad} 沒有丟錯`) } catch (e) { if (!(e instanceof BudgetError)) fail(`非 BudgetError：${e}`) }
        }
        // 範圍內每個整數坪都要做得出來（範本與程序化聯集不可有缺口）
        const src = { template: 0, procedural: 0 }, tpls = new Set<string>()
        for (let ping = lo; ping <= hi; ping++) {
          try { const g = generateLayout({ ...base, ping, seed: 1 }); src[g.variant.source ?? "procedural"]++; if (g.variant.template) tpls.add(g.variant.template) }
          catch (e) { fail(`${JSON.stringify(base)} ping=${ping} 在範圍內卻做不出來：${e}`) }
        }
        if (src.template) coverage.push(`${bedrooms}房${livings}廳${baths}衛${kitchen === "open" ? "開" : "獨"}：範本 ${src.template} 坪級（${[...tpls].join(",")}）／程序化 ${src.procedural}`)
        const pings = [lo, Math.round((lo + hi) / 2), hi, Math.round(lo + (hi - lo) * 0.25), Math.round(lo + (hi - lo) * 0.8)]
        for (const ping of pings) for (let seed = 1; seed <= 16; seed++) {
          total++
          const g = generateLayout({ ...base, ping, seed })
          const errs = validateLayout(g)
          if (errs.length) fail(`${g.blueprint.id} ping=${ping}: ${errs.slice(0, 4).join("；")}`)
        }
      }
// NaN／非數字
for (const bad of [{ ping: NaN }, { bedrooms: NaN }, { seed: Infinity }, { ping: "20" as unknown as number }]) {
  try { generateLayout({ bedrooms: 2, ...bad }); fail(`非數字輸入 ${JSON.stringify(bad)} 沒有丟錯`) } catch (e) { if (!(e instanceof BudgetError)) fail(`非數字輸入丟了非 BudgetError：${e}`) }
}
// 預算好的範本坪數段必須與即時計算一致
{
  const pre = JSON.parse(readFileSync(new URL("../src/game/layout/templateSpans.json", import.meta.url), "utf8"))
  for (const k of Object.keys(pre)) {
    const [id, b, l, ba] = k.split("|")
    const t = TEMPLATES.find((x) => x.id === id)!
    const live = templateSpan(t, normalizeConfig({ bedrooms: +b as 1, livings: +l as 1, baths: +ba as 1, kitchen: t.rooms.some((r) => r.type === "kitchen") ? "closed" : "open", ping: 30 }), true)
    if (JSON.stringify(live) !== JSON.stringify(pre[k])) fail(`templateSpans.json 過期：${k} 預算 ${pre[k]} 即時 ${live}（請重跑 scripts/precompute-template-spans.ts）`)
  }
}
// 決定性（程序化與範本）
const T = { bedrooms: 2, baths: 2, livings: 1, kitchen: "open", ping: 32, seed: 3 } as const
if (JSON.stringify(generateLayout(T)) !== JSON.stringify(generateLayout(T))) fail("範本：同 seed 輸出不同")
if (generateLayout(T).variant.source !== "template") fail("2房2衛開放廚房 32 坪應使用範本")
const A = { bedrooms: 3, baths: 2, livings: 2, kitchen: "closed", seed: 7 } as const
if (JSON.stringify(generateLayout(A)) !== JSON.stringify(generateLayout(A))) fail("同 seed 輸出不同")
// 換一個：一定和前一個不同；拓撲要有變化
for (const bedrooms of [1, 2, 3, 4] as const) for (const baths of [1, 2, 3] as const) {
  let g = generateLayout({ bedrooms, baths, seed: 1 })
  const topo = new Set<string>()
  for (let k = 0; k < 12; k++) {
    const s = nextDistinctSeed(g.config, g)
    const n = generateLayout({ ...g.config, seed: s })
    if (JSON.stringify(n.blueprint.walls) === JSON.stringify(g.blueprint.walls)) fail(`換一個 ${bedrooms}房${baths}衛 seed ${g.config.seed}→${s} 結果相同`)
    topo.add(JSON.stringify(n.variant)); g = n
  }
  if (topo.size < 2) fail(`${bedrooms}房${baths}衛 換 12 次拓撲都一樣`)
}
console.log("可行坪數範圍：\n  " + ranges.join("\n  "))
console.log("範本覆蓋（每個整數坪 seed=1）：\n  " + (coverage.join("\n  ") || "無"))
// 反例：驗證器必須抓到違規
{
  const neg = (label: string, mutate: (g: ReturnType<typeof generateLayout>) => void, expect: RegExp) => {
    const g = generateLayout({ bedrooms: 2, kitchen: "closed", seed: 5 })
    mutate(g)
    const errs = validateLayout(g)
    if (!errs.some((e) => expect.test(e))) fail(`反例未被抓到：${label} ${errs}`)
  }
  // 範本反例
  const negT = (label: string, mutate: (g: ReturnType<typeof generateLayout>) => void, expect: RegExp) => {
    const g = generateLayout(T)
    mutate(g)
    const errs = validateLayout(g)
    if (!errs.some((e) => expect.test(e))) fail(`範本反例未被抓到：${label} ${errs}`)
  }
  negT("沒有曬衣陽台", (g) => g.blueprint.planRooms.forEach((r) => (r.name = r.name.replace(/工作陽台|（可曬衣）/, ""))), /曬衣/)
  negT("陽台欄杆缺口→大門關著也進得來", (g) => { g.blueprint.walls = g.blueprint.walls.filter((w) => w[4] !== "low" && w[4] !== "e") }, /大門關著|出生點|無法到達/)
  negT("門太窄", (g) => { g.blueprint.swingDoors[1].len = 400 }, /門寬/)
  neg("客廳通陽台用門", (g) => {
    const s = g.blueprint.slidingDoors.pop()!
    g.blueprint.swingDoors.push({ name: "x", rect: s.rect, h: [s.rect[0], s.rect[1]], c: [1, 0], o: [0, 1], len: 900 })
  }, /落地窗/)
  neg("廚房通陽台用落地窗", (g) => {
    const i = g.blueprint.swingDoors.findIndex((d) => d.name === "工作陽台門")
    const d = g.blueprint.swingDoors.splice(i, 1)[0]
    g.blueprint.slidingDoors.push({ rect: d.rect, v: true })
  }, /落地窗只能|必須用門/)
  neg("臥室無門", (g) => { g.blueprint.swingDoors = g.blueprint.swingDoors.filter((d) => d.name !== "次臥室門") }, /沒有門/)
  neg("無大門", (g) => { g.blueprint.swingDoors.forEach((d) => (d.entry = false)) }, /大門數量/)
  neg("出生點在牆裡", (g) => { g.spawn.at = [-100, g.spawn.at[1]] }, /出生點/)
  neg("超出預算", (g) => { g.config.ping = g.config.ping * 0.7 }, /預算/)
  neg("少一間臥室", (g) => { const r = g.blueprint.planRooms.find((r) => r.id === "bed2")!; g.kinds[r.id] = "storage" }, /臥室/)
  neg("保齡球道客廳", (g) => { const z = g.zones.living; g.zones.living = [z[0], z[1], z[0] + (z[3] - z[1]) * 4, z[3]] }, /長寬比/)
  neg("開口重疊", (g) => { const d = g.blueprint.swingDoors[0]; g.blueprint.windowOpenings.push([...d.rect]) }, /重疊/)
  neg("廚房無窗", (g) => { const k = g.zones.kitchen; g.blueprint.windowOpenings = g.blueprint.windowOpenings.filter((o) => !(o[0] >= k[0] - 1 && o[2] <= k[2] + 1 && o[1] >= k[3] - 1)) }, /廚房 沒有窗/)
}
console.log(`${total} layouts checked, ${failed} failed`)
if (failed) process.exit(1)
console.log("All layout generator checks passed (incl. budget ±12%, room limits, negative cases).")
