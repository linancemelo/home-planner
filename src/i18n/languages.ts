/** UI language. Phase 1 ships Traditional Chinese (Taiwan) only; multi-lang is TODO. */
export const UI_LANGUAGES = ["zht"] as const
export type UiLanguage = (typeof UI_LANGUAGES)[number]
export const DEFAULT_UI_LANGUAGE: UiLanguage = "zht"
