import type { FloorplanAiProvider } from "./provider"
import { geminiVisionFloorplanProvider } from "./geminiVision"
import { nullFloorplanAiProvider } from "./nullProvider"
import { openAiVisionFloorplanProvider } from "./openaiVision"

/**
 * Prefer OpenAI if configured, else Gemini, else null (heuristic-only).
 * Key plug-in path: set VITE_OPENAI_API_KEY or VITE_GEMINI_API_KEY in .env.local.
 */
export function resolveFloorplanAiProvider(): FloorplanAiProvider {
  if (openAiVisionFloorplanProvider.isConfigured()) return openAiVisionFloorplanProvider
  if (geminiVisionFloorplanProvider.isConfigured()) return geminiVisionFloorplanProvider
  return nullFloorplanAiProvider
}
