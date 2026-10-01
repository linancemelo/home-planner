/**
 * Local FastAPI detect client (mock | YOLO).
 *
 * Env: VITE_DETECT_API_URL
 * - Unset / empty / "off" → backend disabled (default for Pages / production builds).
 * - Dev: set in `.env.local` to `http://127.0.0.1:8000`.
 *
 * When configured: quick GET /health (~400ms) so a down backend fails fast;
 * then POST detect (longer abort, YOLO may need seconds on CPU).
 * Failure falls back to heuristic / AI in the import wizard.
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
  mode?: "mock" | "yolo"
  fallbackFromYolo?: boolean
}

/** Default OFF so GitHub Pages builds do not wait on unreachable localhost. */
const HEALTH_TIMEOUT_MS = 400
/** After health OK; YOLO on CPU can take several seconds. */
const FETCH_TIMEOUT_MS = 30000

export function getDetectApiBaseUrl(): string | null {
  const raw = import.meta.env.VITE_DETECT_API_URL
  // Unset → disabled (prefer .env.local for local backend)
  if (raw === undefined || raw === null) return null
  const url = String(raw).trim()
  if (!url || url.toLowerCase() === "off") return null
  return url.replace(/\/$/, "")
}

export function isDetectApiConfigured(): boolean {
  return getDetectApiBaseUrl() !== null
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

/** Fast probe so a down backend fails in ~HEALTH_TIMEOUT_MS instead of hanging. */
export async function probeDetectApiHealth(): Promise<{
  ok: boolean
  mode?: string
}> {
  const base = getDetectApiBaseUrl()
  if (!base) return { ok: false }
  try {
    const res = await fetchWithTimeout(`${base}/health`, { method: "GET" }, HEALTH_TIMEOUT_MS)
    if (!res.ok) return { ok: false }
    const data = (await res.json().catch(() => null)) as { status?: string; mode?: string } | null
    return { ok: data?.status === "ok", mode: data?.mode }
  } catch {
    return { ok: false }
  }
}

export async function postDetectImage(file: File): Promise<DetectApiResponse> {
  const base = getDetectApiBaseUrl()
  if (!base) throw new Error("Detect API URL 未設定")

  const health = await probeDetectApiHealth()
  if (!health.ok) {
    throw new Error("Detect API 健康檢查失敗（後端未啟動或逾時）")
  }

  const form = new FormData()
  form.append("file", file, file.name || "upload.png")

  const res = await fetchWithTimeout(
    `${base}/api/v1/detect`,
    { method: "POST", body: form },
    FETCH_TIMEOUT_MS,
  )
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Detect API HTTP ${res.status}: ${text.slice(0, 120)}`)
  }
  const data = (await res.json()) as DetectApiResponse
  if (data?.kind !== "detect-result" || data?.version !== 1) {
    throw new Error("Detect API 回應格式不符（需 kind=detect-result, version=1）")
  }
  return data
}
