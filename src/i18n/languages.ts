/** Supported UI languages. Default for Phase 1: Traditional Chinese (Taiwan). */
export const UI_LANGUAGES = ["zht", "zh", "en"] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]
export const DEFAULT_UI_LANGUAGE: UiLanguage = "zht"
