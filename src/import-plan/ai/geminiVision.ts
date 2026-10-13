import type { FloorplanAiProposeInput, FloorplanAiProvider } from "./provider"
import type { AiFloorplanProposal } from "./proposal"
import { assertNotFloorplanJson, parseAiFloorplanProposal } from "./proposal"

function readGeminiKey(): string {
  return (
    process.env.NEXT_PUBLIC_GEMINI_API_KEY?.trim() ||
    process.env.VITE_GEMINI_API_KEY?.trim() ||
    ""
  )
}

/**
 * Gemini Vision stub. Reads `VITE_GEMINI_API_KEY` via `isConfigured()`.
 * No network until the key plug-in path is completed.
 */
export class GeminiVisionFloorplanProvider implements FloorplanAiProvider {
  readonly id = "gemini-vision"
  readonly label = "Gemini Vision"

  isConfigured(): boolean {
    return readGeminiKey().length > 0
  }

  async propose(input: FloorplanAiProposeInput): Promise<AiFloorplanProposal | null> {
    if (!this.isConfigured()) return null
    const stub: AiFloorplanProposal = parseAiFloorplanProposal({
      version: 1,
      kind: "ai-proposal",
      coordinateSpace: "meters-bottom-left",
      model: "gemini-vision-stub",
      rooms: [],
      wallHints: [],
      doorCandidates: [],
      windowCandidates: [],
      ocrLabels: [],
      notes: [
        "Gemini Vision stub: VITE_GEMINI_API_KEY present; HTTP vision call not wired yet.",
        `source=${input.sourceName} ${input.imageWidthPx}×${input.imageHeightPx}`,
      ],
    })
    assertNotFloorplanJson(stub)
    return stub
  }
}

export const geminiVisionFloorplanProvider = new GeminiVisionFloorplanProvider()
