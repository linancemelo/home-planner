import type { Floorplan, Vec2 } from "../types/floorplan.ts"
import { canonicalize, dist } from "./geometry.ts"

export type CompareReport = {
  ok: boolean
  toleranceM: number
  walls: { matched: number; expected: number; actual: number; maxErrorM: number }
  doors: { matched: number; expected: number; actual: number; maxErrorM: number }
  windows: { matched: number; expected: number; actual: number; maxErrorM: number }
  problems: string[]
}

export function compareFloorplans(
  actual: Floorplan,
  expected: Floorplan,
  toleranceM = 0.12,
): CompareReport {
  const problems: string[] = []
  const walls = matchSegments(
    actual.walls.map((w) => [w.a, w.b] as const),
    expected.walls.map((w) => [w.a, w.b] as const),
    toleranceM,
  )
  const doors = matchSegments(
    actual.doors.map((d) => [d.opening.a, d.opening.b] as const),
    expected.doors.map((d) => [d.opening.a, d.opening.b] as const),
    toleranceM,
  )
  const windows = matchSegments(
    actual.windows.map((w) => [w.opening.a, w.opening.b] as const),
    expected.windows.map((w) => [w.opening.a, w.opening.b] as const),
    toleranceM,
  )

  if (walls.matched !== expected.walls.length || actual.walls.length !== expected.walls.length) {
    problems.push(`牆段 ${actual.walls.length}（對上 ${walls.matched}），標註 ${expected.walls.length}`)
  }
  if (doors.matched !== expected.doors.length || actual.doors.length !== expected.doors.length) {
    problems.push(`門 ${actual.doors.length}（對上 ${doors.matched}），標註 ${expected.doors.length}`)
  }
  if (windows.matched !== expected.windows.length || actual.windows.length !== expected.windows.length) {
    problems.push(`窗 ${actual.windows.length}（對上 ${windows.matched}），標註 ${expected.windows.length}`)
  }

  for (const pair of doors.pairs) {
    const got = actual.doors[pair.actual]
    const want = expected.doors[pair.expected]
    if (got.kind !== want.kind) problems.push(`門種類不符：得到 ${got.kind}，標註 ${want.kind}`)
    if (want.kind === "swing" && want.swing && got.swing) {
      if (got.swing.openDirection !== want.swing.openDirection) {
        problems.push(`平開門開向不符：得到 ${got.swing.openDirection}，標註 ${want.swing.openDirection}`)
      }
      if (got.swing.arcQuarter !== true) problems.push("平開門缺少四分之一圓弧標記")
      const leafErr = Math.abs(got.swing.leafLengthM - want.swing.leafLengthM)
      if (leafErr > toleranceM) problems.push(`門扇長度誤差 ${leafErr.toFixed(3)} m`)
    }
    if (want.kind === "sliding" && want.sliding && got.sliding) {
      const leafErr = slidingError(got.sliding, want.sliding)
      if (leafErr > toleranceM) problems.push(`拉門門扇誤差 ${leafErr.toFixed(3)} m`)
    }
  }

  return {
    ok: problems.length === 0,
    toleranceM,
    walls: summary(walls, actual.walls.length, expected.walls.length),
    doors: summary(doors, actual.doors.length, expected.doors.length),
    windows: summary(windows, actual.windows.length, expected.windows.length),
    problems,
  }
}

function summary(
  match: { matched: number; maxErrorM: number },
  actual: number,
  expected: number,
) {
  return { matched: match.matched, expected, actual, maxErrorM: match.maxErrorM }
}

function endpointError(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): number {
  const [p0, p1] = canonicalize(a0, a1)
  const [q0, q1] = canonicalize(b0, b1)
  return Math.max(dist(p0, q0), dist(p1, q1))
}

function matchSegments(
  actual: readonly (readonly [Vec2, Vec2])[],
  expected: readonly (readonly [Vec2, Vec2])[],
  tol: number,
): { matched: number; maxErrorM: number; pairs: { actual: number; expected: number; error: number }[] } {
  const used = new Set<number>()
  const pairs: { actual: number; expected: number; error: number }[] = []
  let maxErrorM = 0
  for (let e = 0; e < expected.length; e++) {
    let best = -1
    let bestErr = Infinity
    for (let a = 0; a < actual.length; a++) {
      if (used.has(a)) continue
      const err = endpointError(actual[a][0], actual[a][1], expected[e][0], expected[e][1])
      if (err < bestErr) {
        bestErr = err
        best = a
      }
    }
    if (best >= 0 && bestErr <= tol) {
      used.add(best)
      pairs.push({ actual: best, expected: e, error: bestErr })
      maxErrorM = Math.max(maxErrorM, bestErr)
    }
  }
  return { matched: pairs.length, maxErrorM, pairs }
}

function slidingError(
  got: { leafA: { a: Vec2; b: Vec2 }; leafB: { a: Vec2; b: Vec2 } },
  want: { leafA: { a: Vec2; b: Vec2 }; leafB: { a: Vec2; b: Vec2 } },
): number {
  const direct = Math.max(
    endpointError(got.leafA.a, got.leafA.b, want.leafA.a, want.leafA.b),
    endpointError(got.leafB.a, got.leafB.b, want.leafB.a, want.leafB.b),
  )
  const swapped = Math.max(
    endpointError(got.leafA.a, got.leafA.b, want.leafB.a, want.leafB.b),
    endpointError(got.leafB.a, got.leafB.b, want.leafA.a, want.leafA.b),
  )
  return Math.min(direct, swapped)
}
