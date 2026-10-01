export {
  getDetectApiBaseUrl,
  isDetectApiConfigured,
  postDetectImage,
  probeDetectApiHealth,
  type DetectApiResponse,
  type DetectApiRoom,
} from "./detectClient.ts"

export {
  mapDetectResponseToFloorplan,
  type BackendDetectMapped,
} from "./mapDetectResponse.ts"
