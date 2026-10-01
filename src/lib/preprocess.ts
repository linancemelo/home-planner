import { clearRect, connectedComponents, erasePixels, type ImageSource } from "./ink.ts"

export type PreprocessResult = {
  width: number
  height: number
  /** 遮罩與去小符號之後，給實心牆與開口使用。 */
  cleaned: Uint8Array
  /** 去掉圖框／圖說之後、仍保留文字與符號，用來拒絕「線中間有字」的假牆。 */
  raw: Uint8Array
  /** 實心粗牆像素，不送進雙線霍夫。 */
  thick: Uint8Array
  /** cleaned 去掉實心粗牆，給雙線偵測。 */
  lines: Uint8Array
  /** 與二值化相同方向的灰階，給門窗的灰色筆畫。 */
  gray: Uint8Array
  notes: string[]
}

export function preprocess(image: ImageSource): PreprocessResult {
  const { width, height, data } = image
  const gray = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    gray[i] = (0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]) | 0
  }

  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  let seen = 0
  const mid = gray.length / 2
  let median = 255
  for (let v = 0; v < 256; v++) {
    seen += hist[v]
    if (seen >= mid) {
      median = v
      break
    }
  }
  if (median < 128) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i]
    hist.fill(0)
    for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  }

  const notes: string[] = []
  let ink: Uint8Array
  if (highContrast(hist)) {
    ink = otsuInk(gray, hist)
  } else {
    ink = photoStructureInk(gray, notes)
    let dark = 0
    for (let i = 0; i < ink.length; i++) dark += ink[i]
    if (dark < ink.length * 0.004) {
      ink = sauvola(gray, width, height, 31, 0.18)
      notes.push("近黑像素太少，已改回局部二值化。")
    }
  }
  denoiseIsolated(ink, width, height)

  maskBorderFrame(ink, width, height, notes)
  maskCornerFrames(ink, width, height, notes)
  maskScaleBar(ink, width, height, notes)
  maskFullWidthBands(ink, width, height, notes)
  maskTitleBlock(ink, width, height, notes)

  const raw = ink.slice()
  const removed = removeSmallSymbols(ink, width, height, notes)
  if (removed.symbols > 0) {
    notes.push("已移除小面積文字、尺寸數字與符號，避免被當成牆。")
  }

  const thick = markThick(ink, width, height)
  const lines = ink.slice()
  for (let i = 0; i < lines.length; i++) {
    if (thick[i]) lines[i] = 0
  }

  return { width, height, cleaned: ink, raw, thick, lines, gray, notes }
}

function highContrast(hist: Uint32Array): boolean {
  let total = 0
  let dark = 0
  let light = 0
  for (let i = 0; i < 256; i++) total += hist[i]
  for (let i = 0; i < 70; i++) dark += hist[i]
  for (let i = 190; i < 256; i++) light += hist[i]
  return total > 0 && dark + light > total * 0.9 && dark > total * 0.001
}

function otsuInk(gray: Uint8Array, hist: Uint32Array): Uint8Array {
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let max = -1
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > max) {
      max = between
      threshold = t
    }
  }
  const ink = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] <= threshold ? 1 : 0
  return ink
}

/** 銷售圖、彩色平面：只留近黑的牆與門線。木紋、地磚、淺色浮水印不進墨水。 */
function photoStructureInk(gray: Uint8Array, notes: string[]): Uint8Array {
  const ink = new Uint8Array(gray.length)
  const threshold = 64
  for (let i = 0; i < gray.length; i++) ink[i] = gray[i] <= threshold ? 1 : 0
  notes.push("彩色或紋理底圖只保留近黑結構線，已略過中間調的地板、家具塗裝與淺色浮水印。")
  return ink
}

function sauvola(
  gray: Uint8Array,
  w: number,
  h: number,
  win: number,
  k: number,
): Uint8Array {
  const ink = new Uint8Array(w * h)
  const half = win >> 1
  const iw = w + 1
  const integ = new Float64Array(iw * (h + 1))
  const integ2 = new Float64Array(iw * (h + 1))
  for (let y = 1; y <= h; y++) {
    let rs = 0
    let rs2 = 0
    const row = (y - 1) * w
    for (let x = 1; x <= w; x++) {
      const v = gray[row + x - 1]
      rs += v
      rs2 += v * v
      const idx = y * iw + x
      integ[idx] = integ[(y - 1) * iw + x] + rs
      integ2[idx] = integ2[(y - 1) * iw + x] + rs2
    }
  }

  for (let y = 0; y < h; y++) {
    const y1 = Math.max(0, y - half)
    const y2 = Math.min(h - 1, y + half)
    for (let x = 0; x < w; x++) {
      const x1 = Math.max(0, x - half)
      const x2 = Math.min(w - 1, x + half)
      const a = y1 * iw + x1
      const b = y1 * iw + (x2 + 1)
      const c = (y2 + 1) * iw + x1
      const d = (y2 + 1) * iw + (x2 + 1)
      const n = (x2 - x1 + 1) * (y2 - y1 + 1)
      const sum = integ[d] - integ[b] - integ[c] + integ[a]
      const sum2 = integ2[d] - integ2[b] - integ2[c] + integ2[a]
      const mean = sum / n
      const variance = Math.max(0, sum2 / n - mean * mean)
      const std = Math.sqrt(variance)
      const thresh = mean * (1 + k * (std / 128 - 1))
      ink[y * w + x] = gray[y * w + x] < thresh ? 1 : 0
    }
  }
  return ink
}

function denoiseIsolated(ink: Uint8Array, w: number, h: number): void {
  const drop: number[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!ink[y * w + x]) continue
      let n = 0
      for (let dy = -1; dy <= 1 && n === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
          if (ink[yy * w + xx]) {
            n++
            break
          }
        }
      }
      if (n === 0) drop.push(y * w + x)
    }
  }
  for (const i of drop) ink[i] = 0
}

function maskBorderFrame(ink: Uint8Array, w: number, h: number, notes: string[]): void {
  const marginX = Math.max(8, Math.round(w * 0.07))
  const marginY = Math.max(8, Math.round(h * 0.07))

  const rowScore = (y: number) => {
    let c = 0
    for (let x = 0; x < w; x++) if (ink[y * w + x]) c++
    return c
  }
  const colScore = (x: number) => {
    let c = 0
    for (let y = 0; y < h; y++) if (ink[y * w + x]) c++
    return c
  }
  const bestRow = (y0: number, y1: number) => {
    let best = -1
    let score = 0
    for (let y = y0; y < y1; y++) {
      const s = rowScore(y)
      if (s > score) {
        score = s
        best = y
      }
    }
    return score > w * 0.55 ? best : -1
  }
  const bestCol = (x0: number, x1: number) => {
    let best = -1
    let score = 0
    for (let x = x0; x < x1; x++) {
      const s = colScore(x)
      if (s > score) {
        score = s
        best = x
      }
    }
    return score > h * 0.55 ? best : -1
  }

  const top = bestRow(0, marginY)
  const bottom = bestRow(h - marginY, h)
  const left = bestCol(0, marginX)
  const right = bestCol(w - marginX, w)
  if (top < 0 || bottom < 0 || left < 0 || right < 0) return
  if (bottom - top < h * 0.4 || right - left < w * 0.4) return

  for (let y = top - 1; y <= top + 1; y++) {
    if (y < 0 || y >= h) continue
    for (let x = left; x <= right; x++) ink[y * w + x] = 0
  }
  for (let y = bottom - 1; y <= bottom + 1; y++) {
    if (y < 0 || y >= h) continue
    for (let x = left; x <= right; x++) ink[y * w + x] = 0
  }
  for (let x = left - 1; x <= left + 1; x++) {
    if (x < 0 || x >= w) continue
    for (let y = top; y <= bottom; y++) ink[y * w + x] = 0
  }
  for (let x = right - 1; x <= right + 1; x++) {
    if (x < 0 || x >= w) continue
    for (let y = top; y <= bottom; y++) ink[y * w + x] = 0
  }
  notes.push("已遮罩外框線。")
}

function maskCornerFrames(ink: Uint8Array, w: number, h: number, notes: string[]): void {
  const comps = connectedComponents(ink, w, h)
  let masked = 0
  for (const comp of comps) {
    const bw = comp.maxX - comp.minX + 1
    const bh = comp.maxY - comp.minY + 1
    const nearLeft = comp.minX < w * 0.1
    const nearRight = comp.maxX > w * 0.9
    const nearTop = comp.minY < h * 0.1
    const nearBottom = comp.maxY > h * 0.9
    const tuckedInCorner = (nearLeft || nearRight) && (nearTop || nearBottom)
    const aspect = Math.max(bw, bh) / Math.max(1, Math.min(bw, bh))
    const cornerFrame =
      tuckedInCorner &&
      bw > 48 &&
      bh > 48 &&
      bw < w * 0.42 &&
      bh < h * 0.42 &&
      aspect < 4.5 &&
      comp.count > 80 &&
      comp.count < bw * bh * 0.55
    if (!cornerFrame) continue
    clearRect(ink, w, h, comp.minX - 2, comp.minY - 2, comp.maxX + 2, comp.maxY + 2)
    masked++
  }
  if (masked > 0) notes.push("已遮罩角落圖框或圖說區。")
}

function maskScaleBar(ink: Uint8Array, w: number, h: number, notes: string[]): void {
  const bands = [
    [Math.floor(h * 0.8), h - 1],
    [0, Math.floor(h * 0.2)],
  ] as const
  let best: { x1: number; x2: number; y: number; score: number } | null = null

  for (const [y0, y1] of bands) {
    for (let y = y0; y <= y1; y++) {
      let x = 0
      const row = y * w
      while (x < w) {
        if (!ink[row + x]) {
          x++
          continue
        }
        let x2 = x
        while (x2 < w && ink[row + x2]) x2++
        const len = x2 - x
        if (len >= 32 && len <= w * 0.3) {
          let partner = false
          for (let dy = 4; dy <= 20 && !partner; dy++) {
            for (const yy of [y - dy, y + dy]) {
              if (yy < 0 || yy >= h) continue
              let hit = 0
              const samples = Math.max(1, Math.floor(len / 2))
              for (let s = 0; s < samples; s++) {
                const xx = x + Math.floor((s * (len - 1)) / samples)
                if (ink[yy * w + xx]) hit++
              }
              if (hit > samples * 0.45) partner = true
            }
          }
          let ticks = 0
          for (let xx = x; xx < x2; xx += 3) {
            let vert = 0
            for (let dy = 2; dy <= 12; dy++) {
              if (y + dy < h && ink[(y + dy) * w + xx]) vert++
              if (y - dy >= 0 && ink[(y - dy) * w + xx]) vert++
            }
            if (vert >= 3) ticks++
          }
          if (!partner && ticks >= 3) {
            const score = ticks + len / 25
            if (!best || score > best.score) best = { x1: x, x2: x2 - 1, y, score }
          }
        }
        x = x2
      }
    }
  }

  if (!best) return
  clearRect(ink, w, h, best.x1 - 3, best.y - 14, best.x2 + 3, best.y + 14)
  notes.push("已遮罩疑似比例尺。")
}

/** 底部色帶、頂部橫幅這類整寬塗色，不是牆。 */
function maskFullWidthBands(ink: Uint8Array, w: number, h: number, notes: string[]): void {
  const bandLimit = Math.floor(h * 0.22)
  const minBand = Math.max(18, Math.floor(h * 0.035))
  const ranges: [number, number][] = [
    [0, bandLimit],
    [h - bandLimit, h - 1],
  ]
  let masked = false
  for (const [y0, y1] of ranges) {
    let runStart = -1
    const flush = (yEnd: number) => {
      if (runStart < 0) return
      const height = yEnd - runStart + 1
      if (height >= minBand) {
        clearRect(ink, w, h, 0, runStart, w - 1, yEnd)
        masked = true
      }
      runStart = -1
    }
    for (let y = y0; y <= y1; y++) {
      let hits = 0
      const row = y * w
      for (let x = 0; x < w; x += 2) if (ink[row + x]) hits++
      const covered = hits / (w / 2) > 0.42
      if (covered && runStart < 0) runStart = y
      if (!covered) flush(y - 1)
    }
    flush(y1)
  }
  if (masked) notes.push("已遮罩整寬色帶或橫幅。")
}

/** 右側整欄圖說：一條幾乎貫高的直線，右邊是稀疏文字而不是實心牆。 */
function maskTitleBlock(ink: Uint8Array, w: number, h: number, notes: string[]): void {
  const y0 = Math.floor(h * 0.05)
  const y1 = Math.floor(h * 0.95)
  const samples = Math.max(1, Math.floor((y1 - y0) / 2))
  const x0 = Math.floor(w * 0.56)
  const x1 = Math.floor(w * 0.9)
  let bestX = -1
  let bestCov = 0
  for (let x = x0; x <= x1; x++) {
    let hits = 0
    for (let y = y0; y < y1; y += 2) {
      const row = y * w
      if (
        ink[row + x] ||
        (x > 0 && ink[row + x - 1]) ||
        (x + 1 < w && ink[row + x + 1])
      ) {
        hits++
      }
    }
    const cov = hits / samples
    if (cov > bestCov) {
      bestCov = cov
      bestX = x
    }
  }
  if (bestX < 0 || bestCov < 0.28) return

  let right = 0
  let rightN = 0
  const rx1 = Math.min(w - 1, bestX + Math.floor(w * 0.3))
  for (let y = y0; y < y1; y += 3) {
    const row = y * w
    for (let x = bestX + 4; x < rx1; x += 3) {
      rightN++
      if (ink[row + x]) right++
    }
  }
  const density = rightN === 0 ? 0 : right / rightN
  if (density < 0.012 || density > 0.2) return
  let rules = 0
  for (let y = y0; y < y1; y++) {
    let run = 0
    let longest = 0
    const row = y * w
    for (let x = bestX + 8; x < rx1; x++) {
      if (ink[row + x]) {
        run++
        if (run > longest) longest = run
      } else {
        run = 0
      }
    }
    if (longest > Math.min(120, w * 0.06)) rules++
  }
  if (rules < 8) return
  clearRect(ink, w, h, bestX - 3, 0, w - 1, h - 1)
  notes.push("已遮罩右側圖說或標題欄。")
}

function removeSmallSymbols(
  ink: Uint8Array,
  w: number,
  h: number,
  notes: string[],
): { symbols: number; northArrows: number } {
  const minDim = Math.min(w, h)
  const small = Math.max(16, Math.round(minDim * 0.022))
  const compact = Math.max(34, Math.round(minDim * 0.055))
  const comps = connectedComponents(ink, w, h)
  let symbols = 0
  let northArrows = 0

  for (const comp of comps) {
    if (!comp.pixels) continue
    const bw = comp.maxX - comp.minX + 1
    const bh = comp.maxY - comp.minY + 1
    const maxSide = Math.max(bw, bh)
    const minSide = Math.max(1, Math.min(bw, bh))
    const aspect = maxSide / minSide
    const circle = looksLikeCircle(comp.pixels, w)
    const inMargin =
      comp.minX < w * 0.3 ||
      comp.maxX > w * 0.7 ||
      comp.minY < h * 0.3 ||
      comp.maxY > h * 0.7

    if (circle && inMargin && maxSide < compact + 16) {
      erasePixels(ink, comp.pixels)
      northArrows++
      symbols++
      continue
    }
    if (maxSide <= small || (maxSide <= compact && aspect < 2.8)) {
      erasePixels(ink, comp.pixels)
      symbols++
    }
  }

  if (northArrows > 0) notes.push("已遮罩疑似指北針。")
  return { symbols, northArrows }
}

function looksLikeCircle(pixels: Uint32Array, w: number): boolean {
  const n = pixels.length
  if (n < 24) return false
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += pixels[i] % w
    sy += (pixels[i] / w) | 0
  }
  const cx = sx / n
  const cy = sy / n
  let sumR = 0
  const radii = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = pixels[i] % w
    const y = (pixels[i] / w) | 0
    const r = Math.hypot(x - cx, y - cy)
    radii[i] = r
    sumR += r
  }
  const mean = sumR / n
  if (mean < 7 || mean > 32) return false
  let acc = 0
  for (let i = 0; i < n; i++) {
    const d = radii[i] - mean
    acc += d * d
  }
  const std = Math.sqrt(acc / n)
  return std / mean < 0.32 && n > mean * 2.2 && n < mean * 14
}

function markThick(ink: Uint8Array, w: number, h: number): Uint8Array {
  const hRun = new Uint16Array(ink.length)
  const vRun = new Uint16Array(ink.length)
  for (let y = 0; y < h; y++) {
    let x = 0
    const row = y * w
    while (x < w) {
      if (!ink[row + x]) {
        x++
        continue
      }
      let x2 = x
      while (x2 < w && ink[row + x2]) x2++
      const run = x2 - x
      for (let i = x; i < x2; i++) hRun[row + i] = run
      x = x2
    }
  }
  for (let x = 0; x < w; x++) {
    let y = 0
    while (y < h) {
      if (!ink[y * w + x]) {
        y++
        continue
      }
      let y2 = y
      while (y2 < h && ink[y2 * w + x]) y2++
      const run = y2 - y
      for (let i = y; i < y2; i++) vRun[i * w + x] = run
      y = y2
    }
  }
  const thick = new Uint8Array(ink.length)
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    if (Math.min(hRun[i], vRun[i]) >= 5) thick[i] = 1
  }
  return thick
}
