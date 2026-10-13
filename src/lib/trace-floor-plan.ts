export interface TracedSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  thickness: number;
}

export interface TracedDoor {
  hingeX: number;
  hingeY: number;
  closedX: number;
  closedY: number;
  openX: number;
  openY: number;
  /** 沒填就是平開門 */
  kind?: "swing" | "sliding";
}

export interface TracedWindow {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TracedPlan {
  width: number;
  height: number;
  walls: TracedSegment[];
  doors: TracedDoor[];
  windows: TracedWindow[];
}

interface Run {
  fixed: number;
  from: number;
  to: number;
}

interface ArcHit {
  hingeX: number;
  hingeY: number;
  closedX: number;
  closedY: number;
  openX: number;
  openY: number;
  radius: number;
  score: number;
}

/**
 * 依圖上的牆線描出平面圖。粗牆的完成圖和細線的施工圖都走同一條流程。
 * 完成圖留粗牆，丟掉傢俱細線；施工圖再拿掉帶刻度的尺寸線。
 * 樓梯踏步和窗格收成外框或一條窗。四分之一圓弧，包含灰色的，是門。
 */
export function traceFloorPlan(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): TracedPlan {
  const empty = { width, height, walls: [], doors: [], windows: [] };
  if (width < 16 || height < 16) return empty;

  const span = Math.max(width, height);
  const ink = inkMask(data, width, height);
  closeGaps(ink, width, height);

  const minRun = Math.max(5, Math.round(span * 0.004));
  const arcStraight = Math.max(8, Math.round(span * 0.018));
  const horizontalRuns = runsAlong(ink, width, height, true, minRun);
  const verticalRuns = runsAlong(ink, width, height, false, minRun);
  const arcPixels = arcMask(curveMask(data, ink, width, height), width, height, arcStraight);

  const maxThickness = Math.max(8, Math.round(span * 0.02));
  const horizontalWalls = dropThicknessSlices(horizontalRuns, verticalRuns, maxThickness);
  const verticalWalls = dropThicknessSlices(verticalRuns, horizontalRuns, maxThickness);
  const grids = takeWindowGrids(horizontalWalls, verticalWalls, span);
  const wallCap = Math.max(6, Math.round(span * 0.012));
  const hole = Math.max(3, Math.round(span * 0.004));
  let walls = pruneAnnotations(
    adaptLineWeight(
      collapseStacks(
        [
          ...segmentsFromRuns(grids.horizontal, true, minRun, maxThickness, hole),
          ...segmentsFromRuns(grids.vertical, false, minRun, maxThickness, hole),
        ],
        span,
      ),
      span,
    ),
    span,
  );

  const doors = doorsFromArcs(arcPixels, width, height, span, walls);
  for (const door of doors) walls = cutDoor(walls, door);
  walls = bridgeGaps(
    walls,
    Math.max(4, Math.round(span * 0.008)),
    doors,
    Math.max(8, Math.round(span * 0.016)),
  );
  walls = connectCorners(walls, Math.max(10, Math.round(span * 0.02)), doors);
  walls = bridgeGaps(walls, Math.max(4, Math.round(span * 0.006)), doors);
  walls = collapseDuplicates(walls, Math.max(5, Math.round(span * 0.008)));
  walls = dropIsolated(walls, Math.max(8, Math.round(span * 0.012)));
  walls = keepLargestNetwork(walls, span);
  const windows = [...grids.windows, ...gapWindows(walls, doors, span)];
  walls = walls.map((segment) => ({
    ...segment,
    thickness: Math.min(Math.max(segment.thickness, 3), wallCap),
  }));

  return { width, height, walls, doors, windows: uniqueWindows(windows) };
}

function luminance(red: number, green: number, blue: number) {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function inkMask(data: Uint8ClampedArray, width: number, height: number) {
  const samples: number[] = [];
  const step = Math.max(4, Math.floor(Math.min(width, height) / 80));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      samples.push(luminance(data[offset], data[offset + 1], data[offset + 2]));
    }
  }
  samples.sort((a, b) => a - b);
  const background = samples[Math.floor(samples.length * 0.72)] ?? 240;
  const limit = Math.min(background - 65, 108);
  const ink = new Uint8Array(width * height);
  for (let index = 0; index < ink.length; index += 1) {
    const offset = index * 4;
    const tone = luminance(data[offset], data[offset + 1], data[offset + 2]);
    ink[index] = tone <= limit && background - tone >= 42 ? 1 : 0;
  }
  return ink;
}

function curveMask(
  data: Uint8ClampedArray,
  hard: Uint8Array,
  width: number,
  height: number,
) {
  const samples: number[] = [];
  const step = Math.max(4, Math.floor(Math.min(width, height) / 80));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      samples.push(luminance(data[offset], data[offset + 1], data[offset + 2]));
    }
  }
  samples.sort((a, b) => a - b);
  const background = samples[Math.floor(samples.length * 0.72)] ?? 240;
  const softLimit = Math.min(background - 28, 168);
  const mask = new Uint8Array(hard);
  for (let index = 0; index < hard.length; index += 1) {
    if (hard[index]) continue;
    const offset = index * 4;
    const tone = luminance(data[offset], data[offset + 1], data[offset + 2]);
    if (tone <= softLimit && background - tone >= 24) mask[index] = 1;
  }
  return mask;
}

function closeGaps(mask: Uint8Array, width: number, height: number) {
  const grown = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index]) {
        grown[index] = 1;
        continue;
      }
      const left = x > 0 && mask[index - 1];
      const right = x + 1 < width && mask[index + 1];
      const up = y > 0 && mask[index - width];
      const down = y + 1 < height && mask[index + width];
      if ((left && right) || (up && down)) grown[index] = 1;
    }
  }
  mask.set(grown);
}

function runsAlong(
  mask: Uint8Array,
  width: number,
  height: number,
  horizontal: boolean,
  minRun: number,
): Run[] {
  const runs: Run[] = [];
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  for (let fixed = 0; fixed < outer; fixed += 1) {
    let from = -1;
    for (let along = 0; along <= inner; along += 1) {
      const on =
        along < inner &&
        mask[horizontal ? fixed * width + along : along * width + fixed] === 1;
      if (on && from < 0) from = along;
      if (!on && from >= 0) {
        if (along - from >= minRun) runs.push({ fixed, from, to: along - 1 });
        from = -1;
      }
    }
  }
  return runs;
}

function arcMask(mask: Uint8Array, width: number, height: number, straight: number) {
  const horizontal = new Uint16Array(mask.length);
  const vertical = new Uint16Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    let from = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && mask[y * width + x] === 1;
      if (on && from < 0) from = x;
      if (!on && from >= 0) {
        const length = x - from;
        for (let column = from; column < x; column += 1) horizontal[y * width + column] = length;
        from = -1;
      }
    }
  }
  for (let x = 0; x < width; x += 1) {
    let from = -1;
    for (let y = 0; y <= height; y += 1) {
      const on = y < height && mask[y * width + x] === 1;
      if (on && from < 0) from = y;
      if (!on && from >= 0) {
        const length = y - from;
        for (let row = from; row < y; row += 1) vertical[row * width + x] = length;
        from = -1;
      }
    }
  }
  const arc = new Uint8Array(mask.length);
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    if (horizontal[index] < straight && vertical[index] < straight) arc[index] = 1;
  }
  return arc;
}

function dropThicknessSlices(runs: Run[], perpendicular: Run[], maxThickness: number) {
  return runs.filter((run) => {
    const length = run.to - run.from + 1;
    if (length > maxThickness * 2) return true;
    const mid = (run.from + run.to) / 2;
    return !perpendicular.some(
      (other) =>
        Math.abs(other.fixed - mid) <= length * 0.35 &&
        run.fixed >= other.from &&
        run.fixed <= other.to,
    );
  });
}

function runCrosses(row: Run, column: Run) {
  return (
    column.fixed >= row.from - 1 &&
    column.fixed <= row.to + 1 &&
    row.fixed >= column.from - 1 &&
    row.fixed <= column.to + 1
  );
}

function mullionsAgainst(host: Run, horizontal: boolean, others: Run[], span: number) {
  const limit = span * 0.18;
  const hits = others.filter((other) => {
    if (other.to - other.from > limit) return false;
    return horizontal ? runCrosses(host, other) : runCrosses(other, host);
  });
  if (hits.length < 3) return [];
  const axis = hits.map((hit) => hit.fixed).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let index = 1; index < axis.length; index += 1) gaps.push(axis[index] - axis[index - 1]);
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? span;
  if (median > span * 0.05) return [];
  return hits;
}

function takeWindowGrids(horizontal: Run[], vertical: Run[], span: number) {
  const dropH = new Set<Run>();
  const dropV = new Set<Run>();
  for (const run of horizontal) {
    for (const hit of mullionsAgainst(run, true, vertical, span)) dropV.add(hit);
  }
  for (const run of vertical) {
    for (const hit of mullionsAgainst(run, false, horizontal, span)) dropH.add(hit);
  }
  const markFrames = (runs: Run[], horizontal: boolean, mullions: Set<Run>, drop: Set<Run>) => {
    for (const run of runs) {
      if (drop.has(run) || run.to - run.from > span * 0.2) continue;
      const hits = [...mullions].filter((other) =>
        horizontal ? runCrosses(run, other) : runCrosses(other, run),
      );
      if (hits.length < 2) continue;
      const along = hits.map((hit) => hit.fixed).sort((a, b) => a - b);
      const coverage = along[along.length - 1] - along[0];
      if (coverage > (run.to - run.from) * 0.55) drop.add(run);
    }
  };
  markFrames(horizontal, true, dropV, dropH);
  markFrames(vertical, false, dropH, dropV);

  const members = [
    ...[...dropH].map((run) => ({ run, horizontal: true })),
    ...[...dropV].map((run) => ({ run, horizontal: false })),
  ];
  const parent = members.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  const touches = (a: (typeof members)[number], b: (typeof members)[number]) => {
    if (a.horizontal === b.horizontal) {
      const gap = a.horizontal
        ? Math.max(a.run.fixed, b.run.fixed) - Math.min(a.run.fixed, b.run.fixed)
        : Math.max(a.run.fixed, b.run.fixed) - Math.min(a.run.fixed, b.run.fixed);
      const along = Math.min(a.run.to, b.run.to) - Math.max(a.run.from, b.run.from);
      return gap <= span * 0.04 && along > 0;
    }
    const row = a.horizontal ? a.run : b.run;
    const column = a.horizontal ? b.run : a.run;
    return runCrosses(row, column);
  };
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      if (!touches(members[i], members[j])) continue;
      parent[find(i)] = find(j);
    }
  }
  const clusters = new Map<number, typeof members>();
  for (let index = 0; index < members.length; index += 1) {
    const root = find(index);
    const list = clusters.get(root);
    if (list) list.push(members[index]);
    else clusters.set(root, [members[index]]);
  }

  const windows: TracedWindow[] = [];
  const keep = new Set<(typeof members)[number]>();
  for (const group of clusters.values()) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const item of group) {
      if (item.horizontal) {
        minX = Math.min(minX, item.run.from);
        maxX = Math.max(maxX, item.run.to);
        minY = Math.min(minY, item.run.fixed);
        maxY = Math.max(maxY, item.run.fixed);
      } else {
        minX = Math.min(minX, item.run.fixed);
        maxX = Math.max(maxX, item.run.fixed);
        minY = Math.min(minY, item.run.from);
        maxY = Math.max(maxY, item.run.to);
      }
    }
    const across = group.filter((item) => item.horizontal).length;
    const down = group.length - across;
    if (across < 2 || down < 2 || Math.max(maxX - minX, maxY - minY) > span * 0.22) {
      for (const item of group) keep.add(item);
      continue;
    }
    if (maxX - minX >= maxY - minY) {
      const y = (minY + maxY) / 2;
      windows.push({ x1: minX, y1: y, x2: maxX, y2: y });
    } else {
      const x = (minX + maxX) / 2;
      windows.push({ x1: x, y1: minY, x2: x, y2: maxY });
    }
  }
  for (const item of keep) {
    if (item.horizontal) dropH.delete(item.run);
    else dropV.delete(item.run);
  }

  return {
    horizontal: horizontal.filter((run) => !dropH.has(run)),
    vertical: vertical.filter((run) => !dropV.has(run)),
    windows,
  };
}

function overlapRatio(a1: number, a2: number, b1: number, b2: number) {
  const overlap = Math.min(a2, b2) - Math.max(a1, b1);
  if (overlap <= 0) return 0;
  return overlap / Math.max(1, Math.min(a2 - a1, b2 - b1));
}

function segmentsFromRuns(
  runs: Run[],
  horizontal: boolean,
  minRun: number,
  maxThickness: number,
  hole: number,
): TracedSegment[] {
  const order = runs
    .map((_, index) => index)
    .sort((a, b) => runs[a].fixed - runs[b].fixed || runs[a].from - runs[b].from);
  const used = new Uint8Array(runs.length);
  const segments: TracedSegment[] = [];

  for (let cursor = 0; cursor < order.length; cursor += 1) {
    const seedIndex = order[cursor];
    if (used[seedIndex]) continue;
    const group = [runs[seedIndex]];
    used[seedIndex] = 1;
    const fixed1 = runs[seedIndex].fixed;
    let fixed2 = fixed1;
    for (let look = cursor + 1; look < order.length; look += 1) {
      const index = order[look];
      const run = runs[index];
      if (run.fixed > fixed1 + maxThickness) break;
      if (used[index] || run.fixed > fixed2 + 2) continue;
      const unionFrom = Math.min(...group.map((item) => item.from));
      const unionTo = Math.max(...group.map((item) => item.to));
      const overlap = Math.min(unionTo, run.to) - Math.max(unionFrom, run.from);
      const runLength = run.to - run.from + 1;
      if (overlap / runLength < 0.62) continue;
      const touches = group.some(
        (item) =>
          Math.abs(item.fixed - run.fixed) <= maxThickness &&
          overlapRatio(item.from, item.to, run.from, run.to) > 0.45,
      );
      if (!touches) continue;
      group.push(run);
      used[index] = 1;
      fixed2 = Math.max(fixed2, run.fixed);
    }
    segments.push(...emitCoverage(group, horizontal, minRun, hole));
  }
  return segments;
}

function emitCoverage(group: Run[], horizontal: boolean, minRun: number, hole: number) {
  const from = Math.min(...group.map((run) => run.from));
  const to = Math.max(...group.map((run) => run.to));
  const cover = new Uint16Array(to - from + 1);
  for (const run of group) {
    for (let value = run.from; value <= run.to; value += 1) cover[value - from] += 1;
  }
  const positive: number[] = [];
  for (const count of cover) if (count > 0) positive.push(count);
  positive.sort((a, b) => a - b);
  const median = positive[Math.floor(positive.length * 0.55)] ?? 1;
  const threshold = Math.max(1, Math.floor(median * 0.55));
  const on: boolean[] = [];
  for (const count of cover) on.push(count >= threshold);
  for (let index = 0; index < on.length; index += 1) {
    if (on[index]) continue;
    let end = index;
    while (end < on.length && !on[end]) end += 1;
    const left = index > 0 && on[index - 1];
    const right = end < on.length && on[end];
    if (left && right && end - index <= hole) {
      for (let fill = index; fill < end; fill += 1) on[fill] = true;
    }
    index = end;
  }

  const mid = from + Math.floor((to - from) / 2);
  const covering = group.filter((run) => run.from <= mid && run.to >= mid);
  const band = covering.length > 0 ? covering : group;
  const band1 = Math.min(...band.map((run) => run.fixed));
  const band2 = Math.max(...band.map((run) => run.fixed));
  const thickness = Math.max(1, band2 - band1 + 1);
  const center = (band1 + band2) / 2;
  const segments: TracedSegment[] = [];
  let start = -1;
  for (let index = 0; index <= on.length; index += 1) {
    const active = index < on.length && on[index];
    if (active && start < 0) start = index;
    if (!active && start >= 0) {
      if (index - start >= minRun) {
        const a = from + start;
        const b = from + index - 1;
        segments.push(
          horizontal
            ? { x1: a, y1: center, x2: b, y2: center, thickness }
            : { x1: center, y1: a, x2: center, y2: b, thickness },
        );
      }
      start = -1;
    }
  }
  return segments;
}

function doorsFromArcs(
  arc: Uint8Array,
  width: number,
  height: number,
  span: number,
  walls: TracedSegment[],
): TracedDoor[] {
  const seen = new Uint8Array(arc.length);
  const hits: ArcHit[] = [];
  const minRadius = Math.max(10, span * 0.012);
  const maxRadius = span * 0.14;
  for (let index = 0; index < arc.length; index += 1) {
    if (!arc[index] || seen[index]) continue;
    const pixels: number[] = [];
    const stack = [index];
    seen[index] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (stack.length > 0) {
      const current = stack.pop() as number;
      pixels.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
        current - width - 1,
        current - width + 1,
        current + width - 1,
        current + width + 1,
      ];
      for (const next of neighbors) {
        if (next < 0 || next >= arc.length || seen[next] || !arc[next]) continue;
        const nextX = next % width;
        if (Math.abs(nextX - x) > 1) continue;
        seen[next] = 1;
        stack.push(next);
      }
    }
    if (pixels.length < 14 || pixels.length > span * 6) continue;
    const boxW = maxX - minX;
    const boxH = maxY - minY;
    if (boxW < minRadius || boxH < minRadius || boxW > maxRadius || boxH > maxRadius) continue;
    const aspect = boxW / Math.max(1, boxH);
    if (aspect < 0.45 || aspect > 2.2) continue;
    const hit = fitQuarterCircle(pixels, width, minX, minY, maxX, maxY, minRadius, maxRadius);
    if (!hit) continue;
    if (distanceToWall(hit.hingeX, hit.hingeY, walls, hit.radius) > Math.max(18, hit.radius * 0.55)) {
      continue;
    }
    const aligned = alignDoorToWall(hit, walls);
    if (!aligned) continue;
    hits.push(aligned);
  }

  hits.sort((a, b) => b.score - a.score);
  const kept: ArcHit[] = [];
  for (const hit of hits) {
    const duplicate = kept.some(
      (other) => Math.hypot(other.hingeX - hit.hingeX, other.hingeY - hit.hingeY) < hit.radius * 0.45,
    );
    if (!duplicate) kept.push(hit);
  }
  return kept.map(({ hingeX, hingeY, closedX, closedY, openX, openY }) => ({
    hingeX,
    hingeY,
    closedX,
    closedY,
    openX,
    openY,
  }));
}

function fitQuarterCircle(
  pixels: number[],
  width: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  minRadius: number,
  maxRadius: number,
): ArcHit | null {
  const corners = [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: minX, y: maxY },
    { x: maxX, y: maxY },
  ];
  let best: ArcHit | null = null;
  for (const corner of corners) {
    const distances: number[] = [];
    for (const pixel of pixels) {
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      distances.push(Math.hypot(x - corner.x, y - corner.y));
    }
    const sorted = [...distances].sort((a, b) => a - b);
    const radius = sorted[Math.floor(sorted.length * 0.55)] ?? 0;
    if (radius < minRadius || radius > maxRadius) continue;
    const tolerance = Math.max(2.5, radius * 0.2);
    const inliers: { x: number; y: number; angle: number }[] = [];
    for (let index = 0; index < pixels.length; index += 1) {
      if (Math.abs(distances[index] - radius) > tolerance) continue;
      const x = pixels[index] % width;
      const y = Math.floor(pixels[index] / width);
      inliers.push({ x, y, angle: Math.atan2(y - corner.y, x - corner.x) });
    }
    if (inliers.length / pixels.length < 0.58 || inliers.length < 12) continue;
    inliers.sort((a, b) => a.angle - b.angle);
    let maxGap = 0;
    for (let index = 1; index < inliers.length; index += 1) {
      maxGap = Math.max(maxGap, inliers[index].angle - inliers[index - 1].angle);
    }
    maxGap = Math.max(
      maxGap,
      inliers[0].angle + Math.PI * 2 - inliers[inliers.length - 1].angle,
    );
    const sweep = Math.PI * 2 - maxGap;
    if (sweep < 0.65 || sweep > 2.15) continue;
    let gapAt = 0;
    let gapSize = inliers[0].angle + Math.PI * 2 - inliers[inliers.length - 1].angle;
    for (let index = 1; index < inliers.length; index += 1) {
      const gap = inliers[index].angle - inliers[index - 1].angle;
      if (gap > gapSize) {
        gapSize = gap;
        gapAt = index;
      }
    }
    const start = inliers[gapAt];
    const end = inliers[(gapAt - 1 + inliers.length) % inliers.length];
    const score = inliers.length * (1 - Math.abs(sweep - Math.PI / 2) / 2);
    if (best && score <= best.score) continue;
    best = {
      hingeX: corner.x,
      hingeY: corner.y,
      closedX: start.x,
      closedY: start.y,
      openX: end.x,
      openY: end.y,
      radius,
      score,
    };
  }
  return best;
}

function alignDoorToWall(hit: ArcHit, walls: TracedSegment[]): ArcHit | null {
  const scoreEnd = (x: number, y: number) => {
    const horizontal = Math.abs(y - hit.hingeY) < Math.abs(x - hit.hingeX);
    let best = Infinity;
    for (const wall of walls) {
      const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
      if (length < hit.radius * 0.7) continue;
      if (isHorizontal(wall) !== horizontal) continue;
      const fixed = horizontal ? wall.y1 : wall.x1;
      const hingeFixed = horizontal ? hit.hingeY : hit.hingeX;
      if (Math.abs(fixed - hingeFixed) > Math.max(18, wall.thickness + 6)) continue;
      const along = horizontal ? hit.hingeX : hit.hingeY;
      const from = horizontal ? wall.x1 : wall.y1;
      const to = horizontal ? wall.x2 : wall.y2;
      if (along < from - hit.radius || along > to + hit.radius) continue;
      best = Math.min(best, Math.abs(fixed - hingeFixed));
    }
    return best;
  };
  const closedScore = scoreEnd(hit.closedX, hit.closedY);
  const openScore = scoreEnd(hit.openX, hit.openY);
  if (Math.min(closedScore, openScore) > Math.max(16, hit.radius * 0.4)) return null;
  const next = { ...hit };
  if (openScore < closedScore) {
    next.closedX = hit.openX;
    next.closedY = hit.openY;
    next.openX = hit.closedX;
    next.openY = hit.closedY;
  }
  const horizontal = Math.abs(next.closedY - next.hingeY) < Math.abs(next.closedX - next.hingeX);
  let wallFixed = horizontal ? next.hingeY : next.hingeX;
  let bestLength = 0;
  for (const wall of walls) {
    const length = Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1);
    if (length < next.radius * 0.7 || isHorizontal(wall) !== horizontal) continue;
    const fixed = horizontal ? wall.y1 : wall.x1;
    const hingeFixed = horizontal ? next.hingeY : next.hingeX;
    const delta = Math.abs(fixed - hingeFixed);
    if (delta <= Math.max(18, wall.thickness + 6) && length > bestLength) {
      bestLength = length;
      wallFixed = fixed;
    }
  }
  if (horizontal) {
    const shift = wallFixed - next.hingeY;
    next.hingeY += shift;
    next.closedY += shift;
    next.openY += shift;
  } else {
    const shift = wallFixed - next.hingeX;
    next.hingeX += shift;
    next.closedX += shift;
    next.openX += shift;
  }
  return next;
}

function distanceToWall(x: number, y: number, walls: TracedSegment[], reach: number) {
  let best = Infinity;
  for (const wall of walls) {
    const horizontal = Math.abs(wall.y1 - wall.y2) <= Math.abs(wall.x1 - wall.x2);
    if (horizontal) {
      if (x < wall.x1 - reach || x > wall.x2 + reach) continue;
      best = Math.min(best, Math.abs(y - wall.y1));
    } else {
      if (y < wall.y1 - reach || y > wall.y2 + reach) continue;
      best = Math.min(best, Math.abs(x - wall.x1));
    }
  }
  return best;
}

function isHorizontal(segment: TracedSegment) {
  return Math.abs(segment.y1 - segment.y2) <= Math.abs(segment.x1 - segment.x2);
}

function cutDoor(walls: TracedSegment[], door: TracedDoor) {
  const opened = splitAlong(walls, door.hingeX, door.hingeY, door.closedX, door.closedY, false);
  return normalizeSegments(splitAlong(opened, door.hingeX, door.hingeY, door.openX, door.openY, true));
}

function splitAlong(
  walls: TracedSegment[],
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  leafOnly: boolean,
) {
  const horizontal = Math.abs(y1 - y2) < Math.abs(x1 - x2);
  const along1 = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
  const along2 = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
  const fixed = horizontal ? (y1 + y2) / 2 : (x1 + x2) / 2;
  const span = along2 - along1;
  return walls.flatMap((wall) => {
    if (isHorizontal(wall) !== horizontal) return [wall];
    const wallFixed = horizontal ? wall.y1 : wall.x1;
    if (Math.abs(wallFixed - fixed) > Math.max(wall.thickness, 8)) return [wall];
    const wall1 = horizontal ? wall.x1 : wall.y1;
    const wall2 = horizontal ? wall.x2 : wall.y2;
    const overlap = Math.min(wall2, along2) - Math.max(wall1, along1);
    if (overlap <= 2) return [wall];
    const mostlyLeaf = wall2 - wall1 < span * 1.35 && overlap > (wall2 - wall1) * 0.55;
    if (leafOnly) return mostlyLeaf ? [] : [wall];
    if (mostlyLeaf) return [];
    const parts: TracedSegment[] = [];
    if (wall1 < along1 - 2) {
      parts.push(horizontal ? { ...wall, x2: along1 } : { ...wall, y2: along1 });
    }
    if (wall2 > along2 + 2) {
      parts.push(horizontal ? { ...wall, x1: along2 } : { ...wall, y1: along2 });
    }
    return parts;
  });
}

function bridgeGaps(
  segments: TracedSegment[],
  limit: number,
  doors: TracedDoor[],
  thickLimit = limit,
) {
  const next = segments.map((segment) => ({ ...segment }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < next.length; i += 1) {
      for (let j = i + 1; j < next.length; j += 1) {
        if (doorBetween(next[i], next[j], doors)) continue;
        const allow =
          next[i].thickness >= 3 && next[j].thickness >= 3 ? thickLimit : limit;
        const joined = joinCollinear(next[i], next[j], allow);
        if (!joined) continue;
        next[i] = joined;
        next.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return next;
}

function doorBetween(a: TracedSegment, b: TracedSegment, doors: TracedDoor[]) {
  if (isHorizontal(a) !== isHorizontal(b)) return false;
  return doors.some((door) => {
    const horizontal = Math.abs(door.hingeY - door.closedY) <= Math.abs(door.hingeX - door.closedX);
    if (horizontal !== isHorizontal(a)) return false;
    const fixed = horizontal ? (door.hingeY + door.closedY) / 2 : (door.hingeX + door.closedX) / 2;
    const wallFixed = horizontal ? a.y1 : a.x1;
    if (Math.abs(fixed - wallFixed) > Math.max(a.thickness, b.thickness, 10)) return false;
    const door1 = horizontal ? Math.min(door.hingeX, door.closedX) : Math.min(door.hingeY, door.closedY);
    const door2 = horizontal ? Math.max(door.hingeX, door.closedX) : Math.max(door.hingeY, door.closedY);
    const left = horizontal ? Math.min(a.x2, b.x2) : Math.min(a.y2, b.y2);
    const right = horizontal ? Math.max(a.x1, b.x1) : Math.max(a.y1, b.y1);
    return Math.min(door2, right) - Math.max(door1, left) > 0;
  });
}

function joinCollinear(a: TracedSegment, b: TracedSegment, limit: number) {
  if (isHorizontal(a) !== isHorizontal(b)) return null;
  if (isHorizontal(a)) {
    if (Math.abs(a.y1 - b.y1) > Math.max(a.thickness, b.thickness, 4)) return null;
    const gap = Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2);
    if (gap > limit) return null;
    return {
      x1: Math.min(a.x1, b.x1),
      x2: Math.max(a.x2, b.x2),
      y1: (a.y1 + b.y1) / 2,
      y2: (a.y1 + b.y1) / 2,
      thickness: Math.max(a.thickness, b.thickness),
    };
  }
  if (Math.abs(a.x1 - b.x1) > Math.max(a.thickness, b.thickness, 4)) return null;
  const gap = Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2);
  if (gap > limit) return null;
  return {
    x1: (a.x1 + b.x1) / 2,
    x2: (a.x1 + b.x1) / 2,
    y1: Math.min(a.y1, b.y1),
    y2: Math.max(a.y2, b.y2),
    thickness: Math.max(a.thickness, b.thickness),
  };
}

function connectCorners(segments: TracedSegment[], reach: number, doors: TracedDoor[]) {
  const next = normalizeSegments(segments.map((segment) => ({ ...segment })));
  for (let pass = 0; pass < 3; pass += 1) {
    for (const segment of next) {
      const horizontal = isHorizontal(segment);
      for (const end of [0, 1] as const) {
        const x = end === 0 ? segment.x1 : segment.x2;
        const y = end === 0 ? segment.y1 : segment.y2;
        let best: { x: number; y: number; other: TracedSegment; distance: number } | null = null;
        for (const other of next) {
          if (other === segment || isHorizontal(other) === horizontal) continue;
          const hit = horizontal
            ? { x: other.x1, y, distance: Math.abs(other.x1 - x) }
            : { x, y: other.y1, distance: Math.abs(other.y1 - y) };
          if (hit.distance > reach || hit.distance < 0.5) continue;
          const along = horizontal ? y : x;
          const otherFrom = horizontal ? other.y1 : other.x1;
          const otherTo = horizontal ? other.y2 : other.x2;
          if (along < otherFrom - reach || along > otherTo + reach) continue;
          if (crossesDoor(x, y, hit.x, hit.y, doors)) continue;
          if (!best || hit.distance < best.distance) best = { ...hit, other };
        }
        if (!best) continue;
        if (end === 0) {
          segment.x1 = best.x;
          segment.y1 = best.y;
        } else {
          segment.x2 = best.x;
          segment.y2 = best.y;
        }
        if (isHorizontal(best.other)) {
          if (best.x < best.other.x1) best.other.x1 = best.x;
          if (best.x > best.other.x2) best.other.x2 = best.x;
        } else if (best.y < best.other.y1) best.other.y1 = best.y;
        else if (best.y > best.other.y2) best.other.y2 = best.y;
      }
    }
  }
  return normalizeSegments(next);
}

function crossesDoor(x1: number, y1: number, x2: number, y2: number, doors: TracedDoor[]) {
  const horizontal = Math.abs(y1 - y2) <= Math.abs(x1 - x2);
  const from = horizontal ? Math.min(x1, x2) : Math.min(y1, y2);
  const to = horizontal ? Math.max(x1, x2) : Math.max(y1, y2);
  const fixed = horizontal ? (y1 + y2) / 2 : (x1 + x2) / 2;
  return doors.some((door) => {
    const doorHorizontal = Math.abs(door.hingeY - door.closedY) <= Math.abs(door.hingeX - door.closedX);
    if (doorHorizontal !== horizontal) return false;
    const doorFixed = doorHorizontal ? (door.hingeY + door.closedY) / 2 : (door.hingeX + door.closedX) / 2;
    if (Math.abs(doorFixed - fixed) > 12) return false;
    const door1 = doorHorizontal ? Math.min(door.hingeX, door.closedX) : Math.min(door.hingeY, door.closedY);
    const door2 = doorHorizontal ? Math.max(door.hingeX, door.closedX) : Math.max(door.hingeY, door.closedY);
    return Math.min(to, door2) - Math.max(from, door1) > 2;
  });
}

function collapseDuplicates(segments: TracedSegment[], perp: number) {
  const next = segments.map((segment) => ({ ...segment }));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < next.length; i += 1) {
      for (let j = i + 1; j < next.length; j += 1) {
        const joined = joinOverlapping(next[i], next[j], perp);
        if (!joined) continue;
        next[i] = joined;
        next.splice(j, 1);
        changed = true;
        break;
      }
    }
  }
  return next;
}

function joinOverlapping(a: TracedSegment, b: TracedSegment, perp: number) {
  if (isHorizontal(a) !== isHorizontal(b)) return null;
  if (isHorizontal(a)) {
    if (Math.abs(a.y1 - b.y1) > perp) return null;
    const overlap = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    if (overlap < 12) return null;
    return {
      x1: Math.min(a.x1, b.x1),
      x2: Math.max(a.x2, b.x2),
      y1: (a.y1 + b.y1) / 2,
      y2: (a.y1 + b.y1) / 2,
      thickness: Math.max(a.thickness, b.thickness),
    };
  }
  if (Math.abs(a.x1 - b.x1) > perp) return null;
  const overlap = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (overlap < 12) return null;
  return {
    x1: (a.x1 + b.x1) / 2,
    x2: (a.x1 + b.x1) / 2,
    y1: Math.min(a.y1, b.y1),
    y2: Math.max(a.y2, b.y2),
    thickness: Math.max(a.thickness, b.thickness),
  };
}

function parallelNeighbor(a: TracedSegment, b: TracedSegment, span: number) {
  if (isHorizontal(a) !== isHorizontal(b)) return false;
  const gap = isHorizontal(a) ? Math.abs(a.y1 - b.y1) : Math.abs(a.x1 - b.x1);
  if (gap < 2 || gap > span * 0.04) return false;
  const overlap = isHorizontal(a)
    ? Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
    : Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  const shorter = Math.min(segmentLength(a), segmentLength(b));
  return overlap > shorter * 0.6;
}

function collapseStacks(segments: TracedSegment[], span: number) {
  const drop = new Set<TracedSegment>();
  const extra: TracedSegment[] = [];
  for (const horizontal of [true, false]) {
    const lines = segments.filter((segment) => isHorizontal(segment) === horizontal);
    const used = new Set<TracedSegment>();
    for (const seed of lines) {
      if (used.has(seed)) continue;
      const group = [seed];
      used.add(seed);
      let grew = true;
      while (grew) {
        grew = false;
        for (const line of lines) {
          if (used.has(line)) continue;
          if (!group.some((member) => parallelNeighbor(member, line, span))) continue;
          group.push(line);
          used.add(line);
          grew = true;
        }
      }
      if (group.length < 5) continue;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const line of group) {
        minX = Math.min(minX, line.x1, line.x2);
        maxX = Math.max(maxX, line.x1, line.x2);
        minY = Math.min(minY, line.y1, line.y2);
        maxY = Math.max(maxY, line.y1, line.y2);
      }
      if (Math.max(maxX - minX, maxY - minY) > span * 0.24) continue;
      if (Math.min(maxX - minX, maxY - minY) < span * 0.02) continue;
      const axis = group.map((line) => (horizontal ? line.y1 : line.x1)).sort((a, b) => a - b);
      const spaces: number[] = [];
      for (let index = 1; index < axis.length; index += 1) spaces.push(axis[index] - axis[index - 1]);
      spaces.sort((a, b) => a - b);
      const median = spaces[Math.floor(spaces.length / 2)] ?? span;
      if (median > span * 0.04) continue;
      for (const line of group) drop.add(line);
      extra.push(
        { x1: minX, y1: minY, x2: maxX, y2: minY, thickness: 4 },
        { x1: minX, y1: maxY, x2: maxX, y2: maxY, thickness: 4 },
        { x1: minX, y1: minY, x2: minX, y2: maxY, thickness: 4 },
        { x1: maxX, y1: minY, x2: maxX, y2: maxY, thickness: 4 },
      );
    }
  }
  if (drop.size === 0) return segments;
  return [...segments.filter((segment) => !drop.has(segment)), ...normalizeSegments(extra)];
}

function adaptLineWeight(segments: TracedSegment[], span: number) {
  const longs = segments.filter((segment) => segmentLength(segment) > span * 0.05);
  if (longs.length < 4) return segments;
  const weights = longs.map((segment) => segment.thickness).sort((a, b) => a - b);
  const median = weights[Math.floor(weights.length / 2)] ?? 1;
  if (median < 3) return segments;
  const reach = Math.max(6, Math.round(span * 0.01));
  return segments.filter((segment) => {
    if (segment.thickness >= 2) return true;
    const joints = segments.filter(
      (other) => other !== segment && other.thickness >= 3 && meets(segment, other, reach),
    ).length;
    return joints >= 2;
  });
}

function segmentLength(segment: TracedSegment) {
  return Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
}

function pruneAnnotations(segments: TracedSegment[], span: number) {
  const reach = Math.max(6, Math.round(span * 0.01));
  const tickLimit = span * 0.02;
  const isTick = (segment: TracedSegment) =>
    segment.thickness <= 2 && segmentLength(segment) <= tickLimit;
  const dimensions = new Set<TracedSegment>();
  for (const segment of segments) {
    if (segment.thickness > 2 || segmentLength(segment) < span * 0.05) continue;
    let ticks = 0;
    let longJoints = 0;
    for (const other of segments) {
      if (other === segment || isHorizontal(segment) === isHorizontal(other)) continue;
      if (!meets(segment, other, reach)) continue;
      if (segmentLength(other) >= span * 0.03) longJoints += 1;
      else if (isTick(other)) ticks += 1;
    }
    if (ticks >= 2 && longJoints === 0) dimensions.add(segment);
  }
  return segments.filter((segment) => {
    if (dimensions.has(segment)) return false;
    if (!isTick(segment)) return true;
    const onDimension = [...dimensions].some(
      (dimension) =>
        isHorizontal(dimension) !== isHorizontal(segment) && meets(dimension, segment, reach),
    );
    if (onDimension) return false;
    const longTouches = segments.filter(
      (other) =>
        other !== segment &&
        segmentLength(other) >= span * 0.03 &&
        meets(segment, other, reach),
    ).length;
    return longTouches >= 2;
  });
}

function keepLargestNetwork(segments: TracedSegment[], span: number) {
  if (segments.length < 4) return segments;
  const reach = Math.max(8, Math.round(span * 0.012));
  const parent = segments.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    return root;
  };
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      if (!meets(segments[i], segments[j], reach)) continue;
      const rootA = find(i);
      const rootB = find(j);
      if (rootA !== rootB) parent[rootA] = rootB;
    }
  }
  const groups = new Map<number, number[]>();
  for (let index = 0; index < segments.length; index += 1) {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(index);
    else groups.set(root, [index]);
  }
  let bestLength = 0;
  const lengths = new Map<number, number>();
  for (const [root, indexes] of groups) {
    const length = indexes.reduce((sum, index) => sum + segmentLength(segments[index]), 0);
    lengths.set(root, length);
    bestLength = Math.max(bestLength, length);
  }
  const minLength = bestLength * 0.2;
  const kept = new Set<number>();
  for (const [root, indexes] of groups) {
    if ((lengths.get(root) ?? 0) < minLength) continue;
    for (const index of indexes) kept.add(index);
  }
  const near = Math.max(reach, Math.round(span * 0.04));
  let grew = true;
  while (grew) {
    grew = false;
    for (let index = 0; index < segments.length; index += 1) {
      if (kept.has(index)) continue;
      const close = [...kept].some((other) => meets(segments[index], segments[other], near));
      if (!close) continue;
      const root = find(index);
      for (let member = 0; member < segments.length; member += 1) {
        if (find(member) === root) kept.add(member);
      }
      grew = true;
    }
  }
  return segments.filter((_, index) => kept.has(index));
}

function dropIsolated(segments: TracedSegment[], minLength: number) {
  return normalizeSegments(segments).filter((segment, index, all) => {
    const length = Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1);
    if (length >= minLength * 2.4) return true;
    return all.some((other, otherIndex) => {
      if (otherIndex === index) return false;
      return endpointNear(segment, other, minLength);
    });
  });
}

function meets(a: TracedSegment, b: TracedSegment, reach: number) {
  return endpointHits(a, b, reach) || endpointHits(b, a, reach);
}

function endpointHits(segment: TracedSegment, other: TracedSegment, reach: number) {
  return [0, 1].some((end) => {
    const x = end === 0 ? segment.x1 : segment.x2;
    const y = end === 0 ? segment.y1 : segment.y2;
    if (isHorizontal(other)) {
      if (x < other.x1 - reach || x > other.x2 + reach) return false;
      return Math.abs(y - other.y1) <= reach;
    }
    if (y < other.y1 - reach || y > other.y2 + reach) return false;
    return Math.abs(x - other.x1) <= reach;
  });
}

function endpointNear(a: TracedSegment, b: TracedSegment, reach: number) {
  const points = [
    [a.x1, a.y1],
    [a.x2, a.y2],
  ];
  const others = [
    [b.x1, b.y1],
    [b.x2, b.y2],
  ];
  return points.some(([x, y]) =>
    others.some(([ox, oy]) => Math.hypot(x - ox, y - oy) <= reach),
  );
}

function gapWindows(walls: TracedSegment[], doors: TracedDoor[], span: number) {
  const minGap = Math.max(8, span * 0.012);
  const maxGap = span * 0.12;
  const windows: TracedWindow[] = [];
  for (let i = 0; i < walls.length; i += 1) {
    for (let j = i + 1; j < walls.length; j += 1) {
      if (doorBetween(walls[i], walls[j], doors)) continue;
      const opening = openingBetween(walls[i], walls[j], minGap, maxGap);
      if (opening) windows.push(opening);
    }
  }
  return windows;
}

function openingBetween(
  a: TracedSegment,
  b: TracedSegment,
  minGap: number,
  maxGap: number,
): TracedWindow | null {
  if (isHorizontal(a) !== isHorizontal(b)) return null;
  if (Math.min(a.thickness, b.thickness) < 3) return null;
  const align = Math.max(a.thickness, b.thickness, 6);
  if (isHorizontal(a)) {
    if (Math.abs(a.y1 - b.y1) > align) return null;
    const left = a.x2 <= b.x1 ? a : b;
    const right = left === a ? b : a;
    const gap = right.x1 - left.x2;
    if (gap < minGap || gap > maxGap) return null;
    const y = (left.y1 + right.y1) / 2;
    return { x1: left.x2, y1: y, x2: right.x1, y2: y };
  }
  if (Math.abs(a.x1 - b.x1) > align) return null;
  const top = a.y2 <= b.y1 ? a : b;
  const bottom = top === a ? b : a;
  const gap = bottom.y1 - top.y2;
  if (gap < minGap || gap > maxGap) return null;
  const x = (top.x1 + bottom.x1) / 2;
  return { x1: x, y1: top.y2, x2: x, y2: bottom.y1 };
}

function uniqueWindows(windows: TracedWindow[]) {
  const kept: TracedWindow[] = [];
  for (const window of windows) {
    const duplicate = kept.some((other) => {
      const same =
        Math.hypot(other.x1 - window.x1, other.y1 - window.y1) < 8 &&
        Math.hypot(other.x2 - window.x2, other.y2 - window.y2) < 8;
      const flipped =
        Math.hypot(other.x1 - window.x2, other.y1 - window.y2) < 8 &&
        Math.hypot(other.x2 - window.x1, other.y2 - window.y1) < 8;
      return same || flipped;
    });
    if (!duplicate) kept.push(window);
  }
  return kept;
}

function normalizeSegments(segments: TracedSegment[]) {
  return segments.map((segment) => {
    if (isHorizontal(segment)) {
      return {
        ...segment,
        x1: Math.min(segment.x1, segment.x2),
        x2: Math.max(segment.x1, segment.x2),
        y1: (segment.y1 + segment.y2) / 2,
        y2: (segment.y1 + segment.y2) / 2,
      };
    }
    return {
      ...segment,
      y1: Math.min(segment.y1, segment.y2),
      y2: Math.max(segment.y1, segment.y2),
      x1: (segment.x1 + segment.x2) / 2,
      x2: (segment.x1 + segment.x2) / 2,
    };
  });
}
