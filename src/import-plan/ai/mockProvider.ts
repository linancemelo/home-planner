import type { FloorplanAiProposeInput, FloorplanAiProvider } from "./provider.ts"
import type { AiFloorplanProposal } from "./proposal.ts"
import { parseAiFloorplanProposal } from "./proposal.ts"

/**
 * Offline mock for topology / assemble tests.
 * Emits a deterministic two-room proposal (metres, bottom-left).
 */
export class MockFloorplanAiProvider implements FloorplanAiProvider {
  readonly id = "mock"
  readonly label = "Mock AI"
  private readonly configured: boolean
  private fixed?: AiFloorplanProposal

  constructor(opts?: { configured?: boolean; proposal?: AiFloorplanProposal }) {
    this.configured = opts?.configured ?? true
    this.fixed = opts?.proposal
  }

  isConfigured(): boolean {
    return this.configured
  }

  async propose(input: FloorplanAiProposeInput): Promise<AiFloorplanProposal | null> {
    if (!this.configured) return null
    if (this.fixed) return this.fixed
    return parseAiFloorplanProposal({
      version: 1,
      kind: "ai-proposal",
      coordinateSpace: "meters-bottom-left",
      model: "mock",
      rooms: [
        {
          id: "r-living",
          label: "客廳",
          polygon: [
            { x: 0, y: 0 },
            { x: 4, y: 0 },
            { x: 4, y: 3 },
            { x: 0, y: 3 },
          ],
          confidence: 0.9,
        },
        {
          id: "r-bed",
          label: "臥室",
          polygon: [
            { x: 4, y: 0 },
            { x: 7, y: 0 },
            { x: 7, y: 3 },
            { x: 4, y: 3 },
          ],
          confidence: 0.85,
        },
      ],
      wallHints: [
        { a: { x: 4, y: 0.2 }, b: { x: 4, y: 2.8 }, role: "structure", confidence: 0.8 },
        { a: { x: 1.2, y: 1.0 }, b: { x: 2.4, y: 1.0 }, role: "furniture", confidence: 0.7 },
      ],
      doorCandidates: [
        {
          openingA: { x: 4, y: 1.0 },
          openingB: { x: 4, y: 1.9 },
          kind: "swing",
          confidence: 0.88,
        },
      ],
      windowCandidates: [
        {
          openingA: { x: 1.5, y: 3 },
          openingB: { x: 2.5, y: 3 },
          confidence: 0.75,
        },
      ],
      ocrLabels: [
        { text: "客廳", at: { x: 2, y: 1.5 }, confidence: 0.9 },
        { text: "臥室", at: { x: 5.5, y: 1.5 }, confidence: 0.85 },
      ],
      notes: [`mock proposal for ${input.sourceName}`],
    })
  }
}

export const mockFloorplanAiProvider = new MockFloorplanAiProvider()
