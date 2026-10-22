/** 「自己建房子格局」的編輯器戶型 → 可走動的 GeneratedLayout（房型用房名猜、出生點放大門外）。 */
import { toTrad } from "./s2t.ts"
import type { PlanBlueprint } from "../../plan/types/blueprint.ts"
import type { SchemeFurniture } from "../../plan/state/schemeStore.ts"
import type { GameFurniture } from "../furnish/autoFurnish.ts"
import { normalizeConfig } from "./generateLayout.ts"
import type { GeneratedLayout, RoomKind } from "./types.ts"
import { pointInPoly } from "./validateLayout.ts"

type P = [number, number]
export function kindFromName(n: string): RoomKind {
  if (/阳台|陽台|露台/.test(n)) return "balcony"
  if (/卫|衛|浴|厕|廁|洗手/.test(n)) return "bath"
  if (/厨|廚/.test(n)) return "kitchen"
  if (/书|書/.test(n)) return "study"
  if (/储|儲|衣帽/.test(n)) return "storage"
  if (/卧|臥|寢/.test(n)) return "bedroom"
  if (/走廊|走道|过道|過道|玄关|玄關/.test(n)) return "hall"
  return "living"
}

export function layoutFromBlueprint(bp0: PlanBlueprint, furniture0: SchemeFurniture[]): { layout: GeneratedLayout; items: GameFurniture[] } | { error: string } {
  // 編輯器資料可能是簡體（預設戶型），遊戲裡顯示的房名、門名、家具名一律轉繁體
  const bp: PlanBlueprint = bp0 && { ...bp0, name: bp0.name && toTrad(bp0.name), planRooms: (bp0.planRooms ?? []).map((r) => ({ ...r, name: toTrad(r.name) })), swingDoors: (bp0.swingDoors ?? []).map((d) => ({ ...d, name: toTrad(d.name) })) }
  const furniture = (furniture0 ?? []).map((f) => ({ ...f, name: f.name && toTrad(f.name) }))
  if (!bp?.planRooms?.length || !bp.walls?.length) return { error: "編輯器裡還沒有格局" }
  const inside = (p: P) => bp.planRooms.some((r) => pointInPoly(p, r.poly as P[]))
  const doors = [...bp.swingDoors].sort((a, b) => Number(!!b.entry) - Number(!!a.entry))
  let spawn: GeneratedLayout["spawn"] | null = null
  for (const d of doors) {
    const r = d.rect, c: P = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2], horiz = r[2] - r[0] >= r[3] - r[1]
    for (const s of [1, -1]) {
      const at: P = horiz ? [c[0], c[1] + s * 1100] : [c[0] + s * 1100, c[1]]
      const back: P = horiz ? [c[0], c[1] - s * 600] : [c[0] - s * 600, c[1]]
      if (!inside(at) && inside(back)) { spawn = { at, lookAt: c }; break }
    }
    if (spawn) break
  }
  if (!spawn) return { error: "找不到通往室外的大門（請在編輯器把大門放在外牆上）" }
  const kinds: Record<string, RoomKind> = {}
  for (const r of bp.planRooms) kinds[r.id] = kindFromName(r.name)
  const layout: GeneratedLayout = {
    config: normalizeConfig({}), blueprint: bp, scheme: { furniture, rooms: {}, demolished: [], measures: [] }, kinds, spawn,
    zones: {}, openKitchenZone: null, livingAreas: [], corridorY: 0, entrySide: "S", areaPing: 0, balconyPing: 0,
    variant: { flip: false, ensuite: false, bathsSouth: false, movedBedrooms: 0, storage: false },
  }
  const roomOf = (f: SchemeFurniture) => bp.planRooms.find((r) => pointInPoly([f.cx, f.cy], r.poly as P[]))?.id ?? ""
  const items = furniture.map((f) => ({ ...f, slot: "desk", slotKey: `editor:${f.id}`, variant: f.type, room: roomOf(f) }) as GameFurniture)
  return { layout, items }
}
