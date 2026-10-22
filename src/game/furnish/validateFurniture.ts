/** 家具配置檢查：必要家具、在房內、不重疊、不壓牆／門扇、擺了家具後每房仍走得到、冰箱與床前走得到。 */
import type { GeneratedLayout } from "../layout/types.ts"
import { pointInPoly } from "../layout/validateLayout.ts"
import { boxOf, type Box, type GameFurniture } from "./autoFurnish.ts"
import { unreachable } from "../scene/reach.ts"

type P = [number, number]
const hit = (a: Box, b: readonly unknown[], m = 0) => a[0] < (b[2] as number) + m && a[2] > (b[0] as number) - m && a[1] < (b[3] as number) + m && a[3] > (b[1] as number) - m
const SOFT = new Set(["rug", "tv"]) // 地毯／壁掛電視可疊放

export function validateFurniture(g: GeneratedLayout, items: GameFurniture[]): string[] {
  const errs: string[] = [], bp = g.blueprint
  const byRoom = (k: string, slot: string) => bp.planRooms.filter((r) => g.kinds[r.id] === k).filter((r) => !items.some((i) => i.room === r.id && i.slot === slot))
  for (const r of byRoom("bedroom", "bed")) errs.push(`${r.name} 沒有床`)
  for (const r of byRoom("bath", "toilet")) errs.push(`${r.name} 沒有馬桶`)
  if (!items.some((i) => i.type === "fridge")) errs.push("沒有冰箱")
  if (!items.some((i) => i.slot === "stove")) errs.push("沒有瓦斯爐")
  // 小客廳（< 25 m²，含開放廚房）放不下沙發時允許省略（UI 會提示）
  const lv = bp.planRooms.find((r) => r.id === "living")
  const area = lv ? Math.abs(lv.poly.reduce((a, p, i) => { const q = lv.poly[(i + 1) % lv.poly.length]; return a + p[0] * q[1] - q[0] * p[1] }, 0)) / 2e6 : 0
  if (!items.some((i) => i.slot === "sofa") && area >= 25) errs.push("沒有沙發")
  const boxes = items.map((i) => boxOf(i.cx, i.cy, i.w, i.d, i.rot))
  items.forEach((it, i) => {
    const room = bp.planRooms.find((r) => r.id === it.room)
    const b = boxes[i]
    if (!room || ![[b[0] + 5, b[1] + 5], [b[2] - 5, b[1] + 5], [b[2] - 5, b[3] - 5], [b[0] + 5, b[3] - 5]].every((p) => pointInPoly(p as P, room.poly as P[]))) errs.push(`${it.name}(${it.id}) 超出房間`)
    if (bp.walls.some((w) => hit(b, w, -3))) errs.push(`${it.name}(${it.id}) 壓到牆`)
    for (const d of bp.swingDoors) {
      const L = d.len, xs = [d.h[0], d.h[0] + d.c[0] * L, d.h[0] + d.o[0] * L], ys = [d.h[1], d.h[1] + d.c[1] * L, d.h[1] + d.o[1] * L]
      if (!SOFT.has(it.type) && hit(b, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], -3)) errs.push(`${it.name}(${it.id}) 擋到門 ${d.name}`)
    }
    for (let j = i + 1; j < items.length; j++) {
      const o = items[j]
      if (SOFT.has(it.type) || SOFT.has(o.type)) continue
      if (hit(b, boxes[j], -3)) errs.push(`${it.name}(${it.id}) 與 ${o.name}(${o.id}) 重疊`)
    }
  })
  // 可達性：用遊戲本身的碰撞模型（scene/reach.ts：玩家 r=0.2 m、門片開 90°、家具碰撞盒），從大門內側出發
  for (const u of unreachable(g, items)) errs.push(`走不到 ${u}`)
  return errs
}
