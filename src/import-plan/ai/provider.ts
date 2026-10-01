import type { AiFloorplanProposal } from "./proposal.ts"

export type FloorplanAiProposeInput = {
  sourceName: string
  imageWidthPx: number
  imageHeightPx: number
  /** data: URL or https URL; stubs may ignore until keys are wired. */
  imageDataUrl?: string
}

/**
 * Vision provider interface. Implementations return a proposal or null
 * (offline / not configured / soft failure). Never return Floorplan JSON.
 */
export interface FloorplanAiProvider {
  readonly id: string
  /** Human label for UI badge path. */
  readonly label: string
  isConfigured(): boolean
  propose(input: FloorplanAiProposeInput): Promise<AiFloorplanProposal | null>
}

export type AssembleUiMode = "heuristic" | "ai+rules" | "backend-mock" | "backend-yolo"

export function modeFromProvider(provider: FloorplanAiProvider, usedAi: boolean): AssembleUiMode {
  return usedAi && provider.isConfigured() ? "ai+rules" : "heuristic"
}
