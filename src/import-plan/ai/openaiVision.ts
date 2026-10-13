import type { FloorplanAiProposeInput, FloorplanAiProvider } from "./provider"
import type { AiFloorplanProposal } from "./proposal"
import { assertNotFloorplanJson, parseAiFloorplanProposal } from "./proposal"

function readOpenAiKey(): string {
  return (
    process.env.NEXT_PUBLIC_OPENAI_API_KEY?.trim() ||
    process.env.VITE_OPENAI_API_KEY?.trim() ||
    ""
  )
}

/**
 * OpenAI Vision stub. Architecture-first: `isConfigured()` reads
 * `VITE_OPENAI_API_KEY`; `propose()` does not call the network yet.
 * When a key is present it returns an empty structured proposal so the
 * assemble path still runs under the AI+規則 badge.
 */
export class OpenAiVisionFloorplanProvider implements FloorplanAiProvider {
  readonly id = "openai-vision"
  readonly label = "OpenAI Vision"

  isConfigured(): boolean {
    return readOpenAiKey().length > 0
  }

  async propose(input: FloorplanAiProposeInput): Promise<AiFloorplanProposal | null> {
    if (!this.isConfigured()) return null
    const stub: AiFloorplanProposal = parseAiFloorplanProposal({
      version: 1,
      kind: "ai-proposal",
      coordinateSpace: "meters-bottom-left",
      model: "openai-vision-stub",
      rooms: [],
      wallHints: [],
      doorCandidates: [],
      windowCandidates: [],
      ocrLabels: [],
      notes: [
        "OpenAI Vision stub: VITE_OPENAI_API_KEY present; HTTP vision call not wired yet.",
        `source=${input.sourceName} ${input.imageWidthPx}×${input.imageHeightPx}`,
      ],
    })
    assertNotFloorplanJson(stub)
    return stub
  }
}

export const openAiVisionFloorplanProvider = new OpenAiVisionFloorplanProvider()
