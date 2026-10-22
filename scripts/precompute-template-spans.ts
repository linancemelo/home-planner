/**
 * 產生 src/game/layout/templateSpans.json（範本 × 組合的可行坪數段），並把「任何組合都用不到」的範本從 templates.json 移除（記在 pruned）。
 * 改了範本、實例化、驗證器或自動家具後要重跑：npx tsx scripts/precompute-template-spans.ts
 * 用得到＝該範本在某組合的可行段，和「程序化範圍起算、相連的聯集」重疊（與 feasibleRange 同一規則）。
 */
import { readFileSync, writeFileSync } from "fs"
import { TEMPLATES, templateFits, templateSpan, spanKey } from "../src/game/layout/templateLayout.ts"
import { normalizeConfig, procRange } from "../src/game/layout/generateLayout.ts"
const out: Record<string, [number, number] | null> = {}
const used = new Set<string>()
for (const bedrooms of [1, 2, 3, 4] as const) for (const livings of [1, 2] as const) for (const baths of [1, 2, 3] as const) for (const kitchen of ["open", "closed"] as const) {
  const cfg = normalizeConfig({ bedrooms, livings, baths, kitchen, ping: 30 })
  const cands: { id: string; span: [number, number] }[] = []
  for (const t of TEMPLATES) if (templateFits(t, cfg)) {
    const k = spanKey(t, cfg)
    if (!(k in out)) out[k] = templateSpan(t, cfg, true)
    if (out[k]) cands.push({ id: t.id, span: out[k]! })
  }
  // 與 feasibleRange 相同：從程序化段（沒有就第一個範本段）起，併入相連的段
  const spans = [procRange(cfg), ...cands.map((c) => c.span)].filter((r) => r[1] >= r[0] && r[1] > 0)
  if (!spans.length) continue
  let [lo, hi] = spans[0]
  for (let grew = true; grew; ) { grew = false; for (const [a, b] of spans) if (a <= hi + 1 && b >= lo - 1 && (a < lo || b > hi)) { lo = Math.min(lo, a); hi = Math.max(hi, b); grew = true } }
  for (const c of cands) if (c.span[0] <= hi && c.span[1] >= lo) used.add(c.id)
}
const tplPath = new URL("../src/game/layout/templates.json", import.meta.url)
const data = JSON.parse(readFileSync(tplPath, "utf8"))
const pruned = data.templates.filter((t: { id: string }) => !used.has(t.id)).map((t: { id: string }) => ({ id: t.id, reason: "所有組合都用不到（擺不下必要家具、遊戲碰撞下走不到，或可行段與其他範圍不相連）" }))
data.templates = data.templates.filter((t: { id: string }) => used.has(t.id))
data.pruned = [...(data.pruned ?? []), ...pruned]
writeFileSync(tplPath, JSON.stringify(data))
const kept = Object.fromEntries(Object.entries(out).filter(([k]) => used.has(k.split("|")[0])))
writeFileSync(new URL("../src/game/layout/templateSpans.json", import.meta.url), JSON.stringify(kept, null, 1) + "\n")
console.log("used", [...used].sort().join(" "), "| pruned", pruned.map((p: { id: string }) => p.id).join(" ") || "-")
console.log(kept)
