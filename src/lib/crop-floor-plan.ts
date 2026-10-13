export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ComponentBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

function borderColor(data: Uint8ClampedArray, width: number, height: number) {
  const margin = Math.max(8, Math.round(Math.min(width, height) * 0.12));
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let y = 0; y < height; y += 3) {
    for (let x = 0; x < width; x += 3) {
      if (x > margin && x < width - margin && y > margin && y < height - margin) continue;
      const index = (y * width + x) * 4;
      const key = `${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`;
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count += 1;
      bucket.r += data[index];
      bucket.g += data[index + 1];
      bucket.b += data[index + 2];
      buckets.set(key, bucket);
    }
  }
  let best = { count: 0, r: 255, g: 255, b: 255 };
  for (const bucket of buckets.values()) {
    if (bucket.count > best.count) best = bucket;
  }
  return { r: best.r / best.count, g: best.g / best.count, b: best.b / best.count };
}

function componentsOf(mask: Uint8Array, gridWidth: number, gridHeight: number): ComponentBox[] {
  const seen = new Uint8Array(mask.length);
  const boxes: ComponentBox[] = [];
  const stack: number[] = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index] || seen[index]) continue;
    let minX = gridWidth;
    let minY = gridHeight;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    stack.push(index);
    seen[index] = 1;
    while (stack.length > 0) {
      const current = stack.pop() as number;
      const x = current % gridWidth;
      const y = Math.floor(current / gridWidth);
      area += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [current - 1, current + 1, current - gridWidth, current + gridWidth];
      for (const next of neighbors) {
        if (next < 0 || next >= mask.length || seen[next] || !mask[next]) continue;
        const nextX = next % gridWidth;
        if (Math.abs(nextX - x) > 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    boxes.push({ minX, minY, maxX, maxY, area });
  }
  return boxes;
}

/**
 * 找出平面圖本體，避開標題、色帶、裝飾花紋和貼齊四邊的外框。
 * 找不到時回傳整張圖。
 */
export function findFloorPlanBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): CropRect {
  if (width < 8 || height < 8) return { x: 0, y: 0, width, height };
  const background = borderColor(data, width, height);
  const step = Math.max(2, Math.round(Math.min(width, height) / 360));
  const gridWidth = Math.ceil(width / step);
  const gridHeight = Math.ceil(height / step);
  const mask = new Uint8Array(gridWidth * gridHeight);

  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x = Math.min(width - 1, gx * step + (step >> 1));
      const y = Math.min(height - 1, gy * step + (step >> 1));
      const index = (y * width + x) * 4;
      const dr = data[index] - background.r;
      const dg = data[index + 1] - background.g;
      const db = data[index + 2] - background.b;
      if (dr * dr + dg * dg + db * db > 32 * 32) mask[gy * gridWidth + gx] = 1;
    }
  }

  const edge = 2;
  const kept = componentsOf(mask, gridWidth, gridHeight).filter((box) => {
    const boxWidth = box.maxX - box.minX + 1;
    const boxHeight = box.maxY - box.minY + 1;
    const touchesFrame =
      box.minX <= edge &&
      box.minY <= edge &&
      box.maxX >= gridWidth - 1 - edge &&
      box.maxY >= gridHeight - 1 - edge;
    if (touchesFrame && box.area < boxWidth * boxHeight * 0.35) return false;
    const banner =
      boxHeight < gridHeight * 0.22 &&
      boxWidth > gridWidth * 0.55 &&
      (box.minY <= gridHeight * 0.08 || box.maxY >= gridHeight * 0.9);
    return !banner;
  });

  if (kept.length === 0) return { x: 0, y: 0, width, height };
  const main = kept.reduce((best, box) => (box.area > best.area ? box : best));
  const plan = kept.filter((box) => {
    if (box === main) return true;
    if (box.area < main.area * 0.08) return false;
    const gapX =
      box.maxX < main.minX ? main.minX - box.maxX : box.minX > main.maxX ? box.minX - main.maxX : 0;
    const gapY =
      box.maxY < main.minY ? main.minY - box.maxY : box.minY > main.maxY ? box.minY - main.maxY : 0;
    return gapX < gridWidth * 0.04 && gapY < gridHeight * 0.04;
  });
  const minX = Math.min(...plan.map((box) => box.minX));
  const minY = Math.min(...plan.map((box) => box.minY));
  const maxX = Math.max(...plan.map((box) => box.maxX));
  const maxY = Math.max(...plan.map((box) => box.maxY));
  const pad = step * 2;
  const x = Math.max(0, minX * step - pad);
  const y = Math.max(0, minY * step - pad);
  const right = Math.min(width, (maxX + 1) * step + pad);
  const bottom = Math.min(height, (maxY + 1) * step + pad);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
