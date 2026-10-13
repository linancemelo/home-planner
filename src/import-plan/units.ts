/** v1 假設值。圖上印的尺寸一律不採信。 */

export const DEFAULT_WALL_THICKNESS_M = 0.12
export const DEFAULT_CEILING_HEIGHT_M = 2.8
export const DEFAULT_SILL_HEIGHT_M = 0.9
export const MIN_SEGMENT_LENGTH_M = 0.3
export const DEFAULT_COORDINATE_ORIGIN = "bottom-left" as const

/** 雙線牆間距估不出來時的每像素公尺數。仍然 scaleTrusted: false。 */
export const FALLBACK_METERS_PER_PIXEL = 0.02

/** 開口端點貼到牆線時允許的像素誤差，再換成公尺。 */
export const OPENING_PROJECT_TOLERANCE_PX = 3
