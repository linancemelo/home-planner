export {
  getDetectApiBaseUrl,
  isDetectApiConfigured,
  postDetectImage,
  probeDetectApiHealth,
  type DetectApiResponse,
  type DetectApiRoom,
} from "./detectClient"

export {
  mapDetectResponseToFloorplan,
  type BackendDetectMapped,
} from "./mapDetectResponse"
