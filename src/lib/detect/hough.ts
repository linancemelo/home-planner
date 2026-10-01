import type { Vec2 } from "../../types/floorplan.ts"
import { dist } from "../geometry.ts"

export type HoughSegment = {
  a: Vec2
  b: Vec2
  theta: number
  rho: number
  cos: number
  sin: number
}

const N_THETA = 180

export function detectLineSegments(ink: Uint8Array, width: number, height: number): HoughSegment[] {
  const points: number[] = []
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      if (ink[row + x]) points.push(x, y)
    }
  }
  if (points.length < 40) return []

  const cos = new Float32Array(N_THETA)
  const sin = new Float32Array(N_THETA)
  for (let t = 0; t < N_THETA; t++) {
    const ang = (t * Math.PI) / N_THETA
    cos[t] = Math.cos(ang)
    sin[t] = Math.sin(ang)
  }

  const rhoMax = Math.ceil(Math.hypot(width, height))
  const nRho = rhoMax * 2 + 1
  const acc = new Int32Array(N_THETA * nRho)
  const nPts = points.length / 2
  const step = nPts > 70000 ? Math.ceil(nPts / 70000) : 1

  for (let i = 0; i < nPts; i += step) {
    const x = points[i * 2]
    const y = points[i * 2 + 1]
    for (let t = 0; t < N_THETA; t++) {
      const rho = x * cos[t] + y * sin[t]
      const ri = Math.round(rho) + rhoMax
      acc[t * nRho + ri]++
    }
  }

  let max = 0
  for (let i = 0; i < acc.length; i++) if (acc[i] > max) max = acc[i]
  const threshold = Math.max(14, Math.floor(max * 0.045))

  const peaks: { t: number; r: number; votes: number }[] = []
  for (let t = 0; t < N_THETA; t++) {
    for (let r = 2; r < nRho - 2; r++) {
      const v = acc[t * nRho + r]
      if (v < threshold) continue
      let isMax = true
      for (let dt = -2; dt <= 2 && isMax; dt++) {
        const tt = (t + dt + N_THETA) % N_THETA
        for (let dr = -2; dr <= 2; dr++) {
          if (dt === 0 && dr === 0) continue
          const rr = r + dr
          if (rr < 0 || rr >= nRho) continue
          if (acc[tt * nRho + rr] > v) {
            isMax = false
            break
          }
        }
      }
      if (isMax) peaks.push({ t, r, votes: v })
    }
  }
  peaks.sort((a, b) => b.votes - a.votes)

  const kept = peaks.slice(0, 90)
  const segments: HoughSegment[] = []
  for (const peak of kept) {
    const theta = (peak.t * Math.PI) / N_THETA
    const rho = peak.r - rhoMax
    const c = cos[peak.t]
    const s = sin[peak.t]
    const extracted = extractRuns(points, theta, rho, c, s)
    for (const seg of extracted) segments.push(seg)
  }
  return dedupeSegments(segments)
}

function extractRuns(
  points: number[],
  theta: number,
  rho: number,
  c: number,
  s: number,
): HoughSegment[] {
  const dirX = -s
  const dirY = c
  const hits: { t: number }[] = []
  const n = points.length / 2
  for (let i = 0; i < n; i++) {
    const x = points[i * 2]
    const y = points[i * 2 + 1]
    const pr = x * c + y * s
    // 2.5px：對角牆的角度量化殘差多半落在這之內；再寬會把距牆面 3px 的窗線接進牆段。
    if (Math.abs(pr - rho) > 2.5) continue
    hits.push({ t: x * dirX + y * dirY })
  }
  if (hits.length < 12) return []
  hits.sort((a, b) => a.t - b.t)

  const out: HoughSegment[] = []
  let start = 0
  const flush = (end: number) => {
    const run = hits.slice(start, end)
    if (run.length < 12) return
    const t0 = run[0].t
    const t1 = run[run.length - 1].t
    const length = t1 - t0
    if (length < 16) return
    if (run.length < length * 0.32) return
    out.push({
      a: { x: rho * c + t0 * dirX, y: rho * s + t0 * dirY },
      b: { x: rho * c + t1 * dirX, y: rho * s + t1 * dirY },
      theta,
      rho,
      cos: c,
      sin: s,
    })
  }

  for (let i = 1; i <= hits.length; i++) {
    if (i === hits.length || hits[i].t - hits[i - 1].t > 8) {
      flush(i)
      start = i
    }
  }
  return out
}

function dedupeSegments(segments: HoughSegment[]): HoughSegment[] {
  const ranked = [...segments].sort((a, b) => dist(b.a, b.b) - dist(a.a, a.b))
  const kept: HoughSegment[] = []
  for (const seg of ranked) {
    const duplicate = kept.some((other) => sameSegment(seg, other))
    if (!duplicate) kept.push(seg)
  }
  return kept
}

function sameSegment(a: HoughSegment, b: HoughSegment): boolean {
  let dTheta = Math.abs(a.theta - b.theta)
  if (dTheta > Math.PI / 2) dTheta = Math.PI - dTheta
  if (dTheta > 0.06) return false
  if (Math.abs(a.rho - b.rho) > 2.5) return false
  const dirX = -a.sin
  const dirY = a.cos
  const proj = (p: { x: number; y: number }) => p.x * dirX + p.y * dirY
  const a0 = proj(a.a)
  const a1 = proj(a.b)
  const b0 = proj(b.a)
  const b1 = proj(b.b)
  const overlap =
    Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1))
  const shorter = Math.min(Math.abs(a1 - a0), Math.abs(b1 - b0))
  return overlap > shorter * 0.7
}
