import type { FloorplanAiProvider } from "./provider.ts"
import { geminiVisionFloorplanProvider } from "./geminiVision.ts"
import { nullFloorplanAiProvider } from "./nullProvider.ts"
import { openAiVisionFloorplanProvider } from "./openaiVision.ts"

/**
 * Prefer OpenAI if configured, else Gemini, else null (heuristic-only).
 * Key plug-in path: set VITE_OPENAI_API_KEY or VITE_GEMINI_API_KEY in .env.local.
 */
export function resolveFloorplanAiProvider(): FloorplanAiProvider {
  if (openAiVisionFloorplanProvider.isConfigured()) return openAiVisionFloorplanProvider
  if (geminiVisionFloorplanProvider.isConfigured()) return geminiVisionFloorplanProvider
  return nullFloorplanAiProvider
}
