/** 兩側都比筆畫亮的細線：黑線、灰門扇、點線圓弧。實心牆內部與木紋塊面不會進來。 */
export function thinStrokes(gray: Uint8Array, width: number, height: number): Uint8Array {
  const mark = new Uint8Array(width * height)
  const dirs: [number, number, number, number][] = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 1, -1, 1],
    [1, -1, 1, 1],
  ]

  for (let y = 3; y < height - 3; y++) {
    const row = y * width
    for (let x = 3; x < width - 3; x++) {
      const g = gray[row + x]
      let hit = false
      if (g <= 168) {
        for (const [dx, dy, px, py] of dirs) {
          const g1 = gray[(y + dy) * width + (x + dx)]
          const g2 = gray[(y - dy) * width + (x - dx)]
          const a2 = gray[(y + 2 * py) * width + (x + 2 * px)]
          const b2 = gray[(y - 2 * py) * width + (x - 2 * px)]
          if (g1 <= g + 32 && g2 <= g + 32 && a2 >= g + 34 && b2 >= g + 34) {
            hit = true
            break
          }
        }
      }
      if (!hit && g >= 78 && g <= 252) {
        for (const [dx, dy, px, py] of dirs) {
          const g1 = gray[(y + dy) * width + (x + dx)]
          const g2 = gray[(y - dy) * width + (x - dx)]
          const a2 = gray[(y + 2 * py) * width + (x + 2 * px)]
          const b2 = gray[(y - 2 * py) * width + (x - 2 * px)]
          const lightLine = Math.abs(g1 - g) <= 40 && Math.abs(g2 - g) <= 40
          const inDarkWall = a2 <= g - 28 && b2 <= g - 28 && a2 < 96 && b2 < 96
          if (lightLine && inDarkWall) {
            hit = true
            break
          }
        }
      }
      if (hit) mark[row + x] = 1
    }
  }

  const out = new Uint8Array(width * height)
  for (let y = 2; y < height - 2; y++) {
    for (let x = 2; x < width - 2; x++) {
      if (!mark[y * width + x]) continue
      let near = 0
      for (let dy = -3; dy <= 3 && near < 3; dy++) {
        const rr = (y + dy) * width
        for (let dx = -3; dx <= 3; dx++) {
          if (mark[rr + x + dx]) near++
        }
      }
      if (near >= 3) out[y * width + x] = 1
    }
  }
  return out
}

/** 高對比、局部稀疏的細線，用來找門弧。實心牆填色與成片木紋不進來。 */
export function doorStrokes(gray: Uint8Array, width: number, height: number): Uint8Array {
  const mark = new Uint8Array(width * height)
  const dirs: [number, number, number, number][] = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 1, -1, 1],
    [1, -1, 1, 1],
  ]
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const g = gray[y * width + x]
      if (g > 155) continue
      for (const [dx, dy, px, py] of dirs) {
        const along1 = gray[(y + dy) * width + (x + dx)]
        const along2 = gray[(y - dy) * width + (x - dx)]
        const a2 = gray[(y + 2 * py) * width + (x + 2 * px)]
        const b2 = gray[(y - 2 * py) * width + (x - 2 * px)]
        if (along1 <= g + 36 && along2 <= g + 36 && a2 >= g + 40 && b2 >= g + 40) {
          mark[y * width + x] = 1
          break
        }
      }
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 6; y < height - 6; y++) {
    for (let x = 6; x < width - 6; x++) {
      if (!mark[y * width + x]) continue
      let n = 0
      for (let dy = -6; dy <= 6; dy++) {
        const row = (y + dy) * width
        for (let dx = -6; dx <= 6; dx++) if (mark[row + x + dx]) n++
      }
      if (n >= 8 && n <= 28) out[y * width + x] = 1
    }
  }
  return out
}

/** 既有牆缺口上的淺灰門扇、點線。只在缺口裡用，不拿來沿實心牆掃圓弧。 */
export function faintStrokes(gray: Uint8Array, width: number, height: number): Uint8Array {
  const mark = new Uint8Array(width * height)
  const dirs: [number, number, number, number][] = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [1, 1, -1, 1],
    [1, -1, 1, 1],
  ]
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const g = gray[y * width + x]
      if (g > 188) continue
      for (const [dx, dy, px, py] of dirs) {
        const along1 = gray[(y + dy) * width + (x + dx)]
        const along2 = gray[(y - dy) * width + (x - dx)]
        const a2 = gray[(y + 2 * py) * width + (x + 2 * px)]
        const b2 = gray[(y - 2 * py) * width + (x - 2 * px)]
        if (along1 <= g + 42 && along2 <= g + 42 && a2 >= g + 22 && b2 >= g + 22) {
          mark[y * width + x] = 1
          break
        }
      }
    }
  }
  const out = new Uint8Array(width * height)
  for (let y = 6; y < height - 6; y++) {
    for (let x = 6; x < width - 6; x++) {
      if (!mark[y * width + x]) continue
      let n = 0
      for (let dy = -6; dy <= 6; dy++) {
        const row = (y + dy) * width
        for (let dx = -6; dx <= 6; dx++) if (mark[row + x + dx]) n++
      }
      if (n >= 6 && n <= 40) out[y * width + x] = 1
    }
  }
  return out
}
