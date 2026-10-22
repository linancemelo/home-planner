/**
 * 替換單件家具：只重新擺這一件（其他家具完全不動）。
 * 靠牆家具維持背貼同一面牆，沿牆左右滑動找空位；自由擺放（餐桌）維持中心再小範圍找。
 * 合法＝validateFurniture 沒有新增錯誤（含遊戲碰撞模型可達性）。放不下回傳 null，呼叫端保留原本的並提示。
 */
import type { GeneratedLayout } from "../layout/types.ts"
import { VARIANTS } from "./variants.ts"
import type { GameFurniture } from "./autoFurnish.ts"
import { validateFurniture } from "./validateFurniture.ts"

const NORMAL: Record<number, [number, number]> = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }

export function swapItem(g: GeneratedLayout, items: GameFurniture[], id: string, variantId: string): GameFurniture[] | null {
  const it = items.find((i) => i.id === id)
  const v = it && VARIANTS[it.slot].find((x) => x.id === variantId)
  if (!it || !v) return null
  const before = new Set(validateFurniture(g, items))
  const n = NORMAL[it.rot] ?? [0, 1], along: [number, number] = [Math.abs(n[1]), Math.abs(n[0])]
  const free = it.slot === "dining"
  // 背貼原牆：背面位置不變
  const bx = it.cx - n[0] * it.d / 2, by = it.cy - n[1] * it.d / 2
  const c0: [number, number] = free ? [it.cx, it.cy] : [bx + n[0] * v.d / 2, by + n[1] * v.d / 2]
  // 跟著這件走的附屬物（電視跟電視櫃）
  const tv = it.slot === "tvstand" ? items.find((i) => i.slot === "tv" && i.room === it.room) : undefined
  const offsets = [0]
  for (let k = 100; k <= 1500; k += 100) offsets.push(k, -k)
  const tries: [number, number][] = free ? offsets.flatMap((a) => [[a, 0], [0, a]] as [number, number][]) : offsets.map((a) => [along[0] * a, along[1] * a])
  for (const [dx, dy] of tries) {
    const nx = Math.round(c0[0] + dx), ny = Math.round(c0[1] + dy)
    const moved: GameFurniture = { ...it, type: v.type, name: v.name, w: v.w, d: v.d, color: v.color, variant: v.id, cx: nx, cy: ny }
    const next = items.map((i) => (i.id === id ? moved : tv && i.id === tv.id ? { ...tv, cx: tv.cx + (nx - it.cx), cy: tv.cy + (ny - it.cy) } : i))
    if (validateFurniture(g, next).every((e) => before.has(e))) return next
  }
  return null
}
