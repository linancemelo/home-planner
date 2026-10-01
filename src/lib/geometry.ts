import type { Vec2 } from "../types/floorplan.ts"

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y }
}

export function mul(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s }
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y
}

export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

export function len(a: Vec2): number {
  return Math.hypot(a.x, a.y)
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function norm(a: Vec2): Vec2 {
  const l = len(a)
  if (l < 1e-9) return { x: 1, y: 0 }
  return { x: a.x / l, y: a.y / l }
}

export function roundM(n: number): number {
  return Math.round(n * 10000) / 10000
}

export function roundVec(p: Vec2): Vec2 {
  return { x: roundM(p.x), y: roundM(p.y) }
}

/** 無向直線的夾角，回傳 0..π/2。 */
export function undirectedAngleDiff(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI
  if (d > Math.PI / 2) d = Math.PI - d
  return d
}

export function segmentAngle(a: Vec2, b: Vec2): number {
  return Math.atan2(b.y - a.y, b.x - a.x)
}

export function projectPoint(
  p: Vec2,
  a: Vec2,
  b: Vec2,
): { point: Vec2; t: number; distance: number } {
  const ab = sub(b, a)
  const l2 = dot(ab, ab)
  if (l2 < 1e-12) return { point: { ...a }, t: 0, distance: dist(p, a) }
  const t = dot(sub(p, a), ab) / l2
  const point = add(a, mul(ab, t))
  return { point, t, distance: dist(p, point) }
}

export function pointLineDistance(p: Vec2, a: Vec2, b: Vec2): number {
  return projectPoint(p, a, b).distance
}

/** 圖頂為 y=0 的像素座標 → 左下原點的公尺座標。 */
export function pixelToMeter(p: Vec2, imageHeightPx: number, mpp: number): Vec2 {
  return { x: p.x * mpp, y: (imageHeightPx - p.y) * mpp }
}

export function meterToPixel(p: Vec2, imageHeightPx: number, mpp: number): Vec2 {
  return { x: p.x / mpp, y: imageHeightPx - p.y / mpp }
}

/** 端點排序：x 較小者在前；x 相同則 y 較小者在前。 */
export function canonicalize(a: Vec2, b: Vec2): [Vec2, Vec2] {
  if (a.x < b.x - 1e-6 || (Math.abs(a.x - b.x) <= 1e-6 && a.y <= b.y)) {
    return [a, b]
  }
  return [b, a]
}

/**
 * 沿牆 a→b 看，門扇開向。
 * y 軸向上時，叉積為正表示門扇在方向左側，記為 ccw。
 */
export function openDirectionOf(
  wallA: Vec2,
  wallB: Vec2,
  hinge: Vec2,
  leafTip: Vec2,
): "cw" | "ccw" {
  const wd = norm(sub(wallB, wallA))
  const ld = norm(sub(leafTip, hinge))
  return cross(wd, ld) >= 0 ? "ccw" : "cw"
}

export function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  const lo = Math.max(Math.min(a0, a1), Math.min(b0, b1))
  const hi = Math.min(Math.max(a0, a1), Math.max(b0, b1))
  return hi - lo
}

export function circDistDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360
  if (d > 180) d = 360 - d
  return d
}
