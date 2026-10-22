/** 系統配置輸入與產生結果型別（單位 mm）。 */
import type { PlanBlueprint } from "../../plan/types/blueprint.ts"
import type { SchemeDocument } from "../../plan/state/schemeStore.ts"

export type KitchenStyle = "open" | "closed"

export type LayoutConfig = {
  bedrooms: 1 | 2 | 3 | 4
  /** 室內實坪（各房間淨面積合計，不含陽台）；undefined → 依組合預設 */
  ping?: number
  livings: 1 | 2
  baths: 1 | 2 | 3
  kitchen: KitchenStyle
  seed: number
}

export type RoomKind = "living" | "bedroom" | "bath" | "kitchen" | "balcony" | "storage" | "study" | "hall"
export type Rect = [number, number, number, number]

export type GeneratedLayout = {
  config: Required<LayoutConfig>
  blueprint: PlanBlueprint
  scheme: SchemeDocument
  /** 房間種類（key = planRooms id） */
  kinds: Record<string, RoomKind>
  /** 出生點（mm，大門外）與面向的點 */
  spawn: { at: [number, number]; lookAt: [number, number] }
  /** 每房主要矩形（mm）；客餐廳為主矩形（不含走道延伸） */
  zones: Record<string, Rect>
  /** 開放廚房區（客餐廳內），獨立廚房為 null */
  openKitchenZone: Rect | null
  /** 範本裡未標示的室內走道（mm 多邊形）；只用來判斷牆是否懸空 */
  halls?: [number, number][][]
  /** 客餐廳內分區標示（2 廳時分客廳區／餐廳區，仍是同一開放空間） */
  livingAreas: { name: string; rect: Rect }[]
  /** 客餐廳北側保留走道的下緣 y（mm） */
  corridorY: number
  /** 大門所在外牆 */
  entrySide: "W" | "E" | "N" | "S"
  /** 室內淨坪（不含陽台）、陽台坪 */
  areaPing: number
  balconyPing: number
  /** 拓撲變體（供「換一個」與 QA 檢視） */
  variant: { flip: boolean; ensuite: boolean; bathsSouth: boolean; movedBedrooms: number; storage: boolean; source?: "template" | "procedural"; template?: string; transform?: number }
}

export const PING_ABS_MAX = 80
export const SQM_PER_PING = 3.305785

/** 坪數不在可行範圍（或非數字）時丟出；UI 顯示明確訊息，不靜默改值。 */
export class BudgetError extends Error {
  constructor(message: string, public range: [number, number] | null) { super(message); this.name = "BudgetError" }
}
