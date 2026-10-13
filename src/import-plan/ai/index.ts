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
} from "./proposal"

export type {
  FloorplanAiProvider,
  FloorplanAiProposeInput,
  AssembleUiMode,
} from "./provider"
export { modeFromProvider } from "./provider"

export { NullFloorplanAiProvider, nullFloorplanAiProvider } from "./nullProvider"
export { MockFloorplanAiProvider, mockFloorplanAiProvider } from "./mockProvider"
export { OpenAiVisionFloorplanProvider, openAiVisionFloorplanProvider } from "./openaiVision"
export { GeminiVisionFloorplanProvider, geminiVisionFloorplanProvider } from "./geminiVision"
export { resolveFloorplanAiProvider } from "./resolveProvider"

export {
  assembleFromAiAndDetect,
  type AssembleResult,
} from "./assemble"

export {
  ensureRoomAccess,
  inferRoomsFromWalls,
  roomsFromPolygons,
  buildRoomAccessGraph,
  snapOpeningToWalls,
  type RoomAccessNode,
  type ConnectivityResult,
} from "./connectivity"
