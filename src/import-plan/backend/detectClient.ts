/**
 * Local FastAPI detect client (mock → later YOLO).
 * Env: VITE_DETECT_API_URL (default http://127.0.0.1:8000). Empty or "off" disables.
 */

export type DetectApiRoom = {
  id: string
  type: string
  vertices: { x: number; y: number }[]
  confidence?: number
}

export type DetectApiResponse = {
  version: 1
  kind: "detect-result"
  meta: {
    sourceName: string
    imageWidthPx: number
    imageHeightPx: number
    metersPerPixel: number
    scaleTrusted: false
    coordinateOrigin: "bottom-left" | "top-left"
    ceilingHeightM: number
    ceilingHeightAssumed: true
    detectionConfidence?: number
    units?: "meters"
    notes?: string[]
  }
  walls: unknown[]
  doors: unknown[]
  windows: unknown[]
  rooms: DetectApiRoom[]
  confidence?: number
  notes?: string[]
  mock?: boolean
}

const DEFAULT_URL = "http://127.0.0.1:8000"
const FETCH_TIMEOUT_MS = 1200

export function getDetectApiBaseUrl(): string | null {
  const raw = import.meta.env.VITE_DETECT_API_URL
  const url = (raw === undefined ? DEFAULT_URL : String(raw)).trim()
  if (!url || url.toLowerCase() === "off") return null
  return url.replace(/\/$/, "")
}

export function isDetectApiConfigured(): boolean {
  return getDetectApiBaseUrl() !== null
}

export async function postDetectImage(file: File): Promise<DetectApiResponse> {
  const base = getDetectApiBaseUrl()
  if (!base) throw new Error("Detect API URL 未設定")

  const form = new FormData()
  form.append("file", file, file.name || "upload.png")

  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${base}/api/v1/detect`, {
      method: "POST",
      body: form,
      signal: ctrl.signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new Error(`Detect API HTTP ${res.status}: ${text.slice(0, 120)}`)
    }
    const data = (await res.json()) as DetectApiResponse
    if (data?.kind !== "detect-result" || data?.version !== 1) {
      throw new Error("Detect API 回應格式不符（需 kind=detect-result, version=1）")
    }
    return data
  } finally {
    window.clearTimeout(timer)
  }
}
