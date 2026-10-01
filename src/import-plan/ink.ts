export type ImageSource = {
  width: number
  height: number
  data: Uint8ClampedArray
}

export function inBounds(x: number, y: number, w: number, h: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h
}

export function inkAt(ink: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  const xi = Math.round(x)
  const yi = Math.round(y)
  if (!inBounds(xi, yi, w, h)) return false
  return ink[yi * w + xi] === 1
}

export function inkNear(
  ink: Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  const r = Math.ceil(radius)
  const x0 = Math.round(x)
  const y0 = Math.round(y)
  const r2 = radius * radius
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2 + 1e-6) continue
      if (inkAt(ink, w, h, x0 + dx, y0 + dy)) return true
    }
  }
  return false
}

export function clearRect(
  ink: Uint8Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const xa = Math.max(0, Math.min(x0, x1))
  const xb = Math.min(w - 1, Math.max(x0, x1))
  const ya = Math.max(0, Math.min(y0, y1))
  const yb = Math.min(h - 1, Math.max(y0, y1))
  for (let y = ya; y <= yb; y++) {
    const row = y * w
    for (let x = xa; x <= xb; x++) ink[row + x] = 0
  }
}

export type Component = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  count: number
  /** 小元件才保留像素；過大的連通域只留外框。 */
  pixels: Uint32Array | null
}

export function connectedComponents(ink: Uint8Array, w: number, h: number): Component[] {
  const seen = new Uint8Array(ink.length)
  const qx = new Int32Array(ink.length)
  const qy = new Int32Array(ink.length)
  const comps: Component[] = []
  const pixelCap = 12000

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const start = y * w + x
      if (!ink[start] || seen[start]) continue
      let qs = 0
      let qe = 0
      qx[qe] = x
      qy[qe] = y
      qe++
      seen[start] = 1
      let minX = x
      let maxX = x
      let minY = y
      let maxY = y
      let count = 0
      const buf = new Uint32Array(pixelCap)
      let stored = 0
      let overflow = false

      while (qs < qe) {
        const cx = qx[qs]
        const cy = qy[qs]
        qs++
        count++
        if (cx < minX) minX = cx
        if (cx > maxX) maxX = cx
        if (cy < minY) minY = cy
        if (cy > maxY) maxY = cy
        if (!overflow) {
          if (stored < pixelCap) buf[stored++] = cy * w + cx
          else overflow = true
        }
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue
            const nx = cx + dx
            const ny = cy + dy
            if (!inBounds(nx, ny, w, h)) continue
            const ni = ny * w + nx
            if (!ink[ni] || seen[ni]) continue
            seen[ni] = 1
            qx[qe] = nx
            qy[qe] = ny
            qe++
          }
        }
      }

      comps.push({
        minX,
        maxX,
        minY,
        maxY,
        count,
        pixels: overflow ? null : buf.slice(0, stored),
      })
    }
  }
  return comps
}

export function erasePixels(ink: Uint8Array, pixels: Uint32Array): void {
  for (let i = 0; i < pixels.length; i++) ink[pixels[i]] = 0
}

/** 長邊壓到 maxSide 以下，回傳相對原圖的縮小倍率（1 表示沒縮）。 */
export function downsample(
  src: ImageSource,
  maxSide: number,
): { image: ImageSource; scale: number } {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height))
  if (scale >= 0.999) return { image: src, scale: 1 }
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const data = new Uint8ClampedArray(w * h * 4)
  const xScale = src.width / w
  const yScale = src.height / h
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, Math.floor(y * yScale))
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * yScale)))
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.width - 1, Math.floor(x * xScale))
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * xScale)))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.width + xx) * 4
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          n++
        }
      }
      const o = (y * w + x) * 4
      data[o] = r / n
      data[o + 1] = g / n
      data[o + 2] = b / n
      data[o + 3] = 255
    }
  }
  return { image: { width: w, height: h, data }, scale }
}
