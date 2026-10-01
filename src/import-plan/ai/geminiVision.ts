import type { FloorplanAiProposeInput, FloorplanAiProvider } from "./provider.ts"
import type { AiFloorplanProposal } from "./proposal.ts"
import { assertNotFloorplanJson, parseAiFloorplanProposal } from "./proposal.ts"

function readGeminiKey(): string {
  try {
    return (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_GEMINI_API_KEY?.trim() ?? ""
  } catch {
    return ""
  }
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
