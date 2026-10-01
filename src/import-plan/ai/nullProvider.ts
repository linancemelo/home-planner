import type { FloorplanAiProposeInput, FloorplanAiProvider } from "./provider.ts"
import type { AiFloorplanProposal } from "./proposal.ts"

/** Always offline: no network, no proposal. */
export class NullFloorplanAiProvider implements FloorplanAiProvider {
  readonly id = "null"
  readonly label = "啟發式"

  isConfigured(): boolean {
    return false
  }

  async propose(_input: FloorplanAiProposeInput): Promise<AiFloorplanProposal | null> {
    return null
  }
}

export const nullFloorplanAiProvider = new NullFloorplanAiProvider()
