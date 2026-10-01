import type { Vec2 } from "../types/floorplan.ts"
import { canonicalize } from "./geometry.ts"

/** FNV-1a。輸入是公分整數，避免浮點雜訊改寫 id。 */
export function stableHash(prefix: string, parts: number[]): string {
  const s = parts.map((n) => Math.round(n * 100).toString()).join("|")
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return `${prefix}${(h >>> 0).toString(16).padStart(8, "0")}`
}

export function wallStableId(a: Vec2, b: Vec2, thicknessM: number): string {
  const [p, q] = canonicalize(a, b)
  return stableHash("w_", [p.x, p.y, q.x, q.y, thicknessM])
}

export function doorStableId(
  kind: string,
  a: Vec2,
  b: Vec2,
  hinge: Vec2 | null,
): string {
  const [p, q] = canonicalize(a, b)
  const extra = hinge ? [hinge.x, hinge.y] : [0, 0]
  return stableHash("d_", [kind === "swing" ? 1 : 2, p.x, p.y, q.x, q.y, ...extra])
}

export function windowStableId(a: Vec2, b: Vec2): string {
  const [p, q] = canonicalize(a, b)
  return stableHash("win_", [p.x, p.y, q.x, q.y])
}
