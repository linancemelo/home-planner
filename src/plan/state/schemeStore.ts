/** localStorage key for scheme persistence (furniture / rooms / measures). */
export const SCHEME_STORAGE_KEY = "home-planner-scheme-v1" as const

/** localStorage key for UI language preference. */
export const LANG_STORAGE_KEY = "home-planner-lang" as const

/** localStorage key for pane visibility preferences. */
export const PANES_STORAGE_KEY = "home-planner-panes-v1" as const

/** Re-export blueprint persistence key (geometry lives beside scheme). */
export { BLUEPRINT_STORAGE_KEY } from "../types/blueprint.ts"

/** Compatible export/import JSON shape (mm units). */
export type SchemeFurniture = {
  id: string
  type: string
  name: string
  cx: number
  cy: number
  w: number
  d: number
  rot: number
  color: string
}

export type SchemeDocument = {
  furniture: SchemeFurniture[]
  rooms: Record<string, { name: string; mat: string }>
  demolished: string[]
  measures: unknown[]
}
