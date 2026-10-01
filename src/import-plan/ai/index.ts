export {
  aiFloorplanProposalSchema,
  parseAiFloorplanProposal,
  assertNotFloorplanJson,
  type AiFloorplanProposal,
  type AiCoordinateSpace,
  type AiRoomHint,
  type AiWallHint,
  type AiDoorCandidate,
  type AiWindowCandidate,
  type AiOcrLabel,
} from "./proposal.ts"

export type {
  FloorplanAiProvider,
  FloorplanAiProposeInput,
  AssembleUiMode,
} from "./provider.ts"
export { modeFromProvider } from "./provider.ts"

export { NullFloorplanAiProvider, nullFloorplanAiProvider } from "./nullProvider.ts"
export { MockFloorplanAiProvider, mockFloorplanAiProvider } from "./mockProvider.ts"
export { OpenAiVisionFloorplanProvider, openAiVisionFloorplanProvider } from "./openaiVision.ts"
export { GeminiVisionFloorplanProvider, geminiVisionFloorplanProvider } from "./geminiVision.ts"
export { resolveFloorplanAiProvider } from "./resolveProvider.ts"

export {
  assembleFromAiAndDetect,
  type AssembleResult,
} from "./assemble.ts"

export {
  ensureRoomAccess,
  inferRoomsFromWalls,
  roomsFromPolygons,
  buildRoomAccessGraph,
  snapOpeningToWalls,
  type RoomAccessNode,
  type ConnectivityResult,
} from "./connectivity.ts"
