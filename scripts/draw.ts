import { PNG } from "pngjs"

export type Pt = { x: number; y: number }

export function createPlan(width: number, height: number): PNG {
  const png = new PNG({ width, height })
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    png.data[o] = 255
    png.data[o + 1] = 255
    png.data[o + 2] = 255
    png.data[o + 3] = 255
  }
  return png
}

export function plot(png: PNG, x: number, y: number, gray = 0): void {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (xi < 0 || yi < 0 || xi >= png.width || yi >= png.height) return
  const o = (yi * png.width + xi) * 4
  png.data[o] = gray
  png.data[o + 1] = gray
  png.data[o + 2] = gray
  png.data[o + 3] = 255
}

export function line(png: PNG, a: Pt, b: Pt, gray = 0): void {
  const x0 = Math.round(a.x)
  const y0 = Math.round(a.y)
  const x1 = Math.round(b.x)
  const y1 = Math.round(b.y)
  const dx = Math.abs(x1 - x0)
  const dy = Math.abs(y1 - y0)
  const sx = x0 < x1 ? 1 : -1
  const sy = y0 < y1 ? 1 : -1
  let err = dx - dy
  let x = x0
  let y = y0
  for (;;) {
    plot(png, x, y, gray)
    if (x === x1 && y === y1) break
    const e2 = 2 * err
    if (e2 > -dy) {
      err -= dy
      x += sx
    }
    if (e2 < dx) {
      err += dx
      y += sy
    }
  }
}

export function rect(png: PNG, x0: number, y0: number, x1: number, y1: number, gray = 0): void {
  line(png, { x: x0, y: y0 }, { x: x1, y: y0 }, gray)
  line(png, { x: x1, y: y0 }, { x: x1, y: y1 }, gray)
  line(png, { x: x1, y: y1 }, { x: x0, y: y1 }, gray)
  line(png, { x: x0, y: y1 }, { x: x0, y: y0 }, gray)
}

export function fillRect(png: PNG, x0: number, y0: number, x1: number, y1: number, gray = 0): void {
  const xa = Math.min(x0, x1)
  const xb = Math.max(x0, x1)
  const ya = Math.min(y0, y1)
  const yb = Math.max(y0, y1)
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) plot(png, x, y, gray)
  }
}

/** 以中心線兩側各 offset 像素畫一對 1px 牆線。gap 以沿中心線的距離切除。 */
export function doubleWall(
  png: PNG,
  a: Pt,
  b: Pt,
  gap?: { from: number; to: number },
): void {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  const dir = { x: dx / len, y: dy / len }
  const n = { x: -dir.y, y: dir.x }
  const off = 6
  const spans: [number, number][] = gap
    ? [
        [0, gap.from],
        [gap.to, len],
      ]
    : [[0, len]]
  for (const [t0, t1] of spans) {
    if (t1 - t0 < 2) continue
    const p0 = { x: a.x + dir.x * t0, y: a.y + dir.y * t0 }
    const p1 = { x: a.x + dir.x * t1, y: a.y + dir.y * t1 }
    line(
      png,
      { x: p0.x + n.x * off, y: p0.y + n.y * off },
      { x: p1.x + n.x * off, y: p1.y + n.y * off },
    )
    line(
      png,
      { x: p0.x - n.x * off, y: p0.y - n.y * off },
      { x: p1.x - n.x * off, y: p1.y - n.y * off },
    )
  }
}

export function solidWall(png: PNG, a: Pt, b: Pt, thickness = 12): void {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const n = { x: -dy / len, y: dx / len }
  const half = thickness / 2
  const samples = Math.ceil(len)
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    const x = a.x + dx * t
    const y = a.y + dy * t
    for (let o = -half; o < half; o++) {
      plot(png, x + n.x * o, y + n.y * o)
    }
  }
}

export function arc(png: PNG, center: Pt, radius: number, deg0: number, deg1: number): void {
  const sweep = deg1 - deg0
  const steps = Math.max(12, Math.ceil(Math.abs(sweep) * 1.2))
  let prev: Pt | null = null
  for (let i = 0; i <= steps; i++) {
    const deg = deg0 + (sweep * i) / steps
    const rad = (deg * Math.PI) / 180
    const p = { x: center.x + Math.cos(rad) * radius, y: center.y + Math.sin(rad) * radius }
    if (prev) line(png, prev, p)
    prev = p
  }
}

export function swingDoor(
  png: PNG,
  hinge: Pt,
  leaf: Pt,
  deg0: number,
  deg1: number,
): void {
  line(png, hinge, leaf)
  const radius = Math.hypot(leaf.x - hinge.x, leaf.y - hinge.y)
  arc(png, hinge, radius, deg0, deg1)
}

export function windowLines(png: PNG, a: Pt, b: Pt): void {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy) || 1
  const n = { x: -dy / len, y: dx / len }
  const inset = 2
  const p0 = { x: a.x + (dx / len) * inset, y: a.y + (dy / len) * inset }
  const p1 = { x: b.x - (dx / len) * inset, y: b.y - (dy / len) * inset }
  for (const off of [-3, 3]) {
    line(
      png,
      { x: p0.x + n.x * off, y: p0.y + n.y * off },
      { x: p1.x + n.x * off, y: p1.y + n.y * off },
    )
  }
}

export function blob(png: PNG, x: number, y: number, w: number, h: number): void {
  fillRect(png, x, y, x + w - 1, y + h - 1, 0)
}
