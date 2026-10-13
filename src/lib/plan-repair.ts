import {
  FIXTURE_DEFAULT_SIZE,
  FIXTURE_KINDS,
  type FixtureKind,
  type FloorPlan,
  type FloorPlanFixture,
  type FloorPlanOpening,
  type FloorPlanRoom,
  type FloorPlanWall,
} from "@/lib/parseFloorPlan";

type Vec2 = [number, number];

const ROOM_TYPES: Record<string, string> = {
  living_room: "living",
  living: "living",
  客廳: "living",
  客餐廳: "living",
  dining_room: "dining",
  dining: "dining",
  餐廳: "dining",
  kitchen: "kitchen",
  廚房: "kitchen",
  bedroom: "bedroom",
  臥室: "bedroom",
  主臥: "bedroom",
  次臥: "bedroom",
  bathroom: "bathroom",
  浴室: "bathroom",
  衛浴: "bathroom",
  衛生間: "bathroom",
  balcony: "balcony",
  陽台: "balcony",
  陽臺: "balcony",
  study: "study",
  書房: "study",
  corridor: "corridor",
  走道: "corridor",
  玄關: "corridor",
};

const WALL_BACKED = new Set<FixtureKind>([
  "bed",
  "sofa",
  "desk",
  "wardrobe",
  "tv",
  "toilet",
  "sink",
  "bathtub",
  "shower",
  "stove",
  "counter",
  "washer",
]);

export interface DetectedRoom {
  type?: string;
  name?: string;
  polygon?: unknown;
}

export interface DetectedOpening {
  position?: unknown;
  width_meters?: number;
  width?: number;
}

export interface DetectedWall {
  start?: unknown;
  end?: unknown;
  kind?: string;
  /** existing 現況、demolish 拆除、new 新增 */
  phase?: string;
}

/** 視覺模型第一段負責牆的現況／拆除／新增、房間輪廓與門窗。幾何仍由輪廓修補。 */
export interface DetectedPlan {
  detected_walls?: DetectedWall[];
  detected_rooms?: DetectedRoom[];
  detected_doors?: DetectedOpening[];
  detected_windows?: DetectedOpening[];
  scale_info?: { detected?: boolean; meters_per_pixel?: number | null };
  overall_dimensions?: { width_meters?: number; height_meters?: number };
  contradictions?: string[];
}

export interface PlannedFixture {
  room?: string;
  kind?: string;
  position?: unknown;
  rotation?: number;
}

function asPair(value: unknown): Vec2 | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function polygonOf(value: unknown): Vec2[] {
  if (!Array.isArray(value)) return [];
  const points = value.map(asPair).filter((point): point is Vec2 => point !== null);
  if (points.length >= 2) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1.5) points.pop();
  }
  return points;
}

function pointInPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersect =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonArea(polygon: Vec2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const [x1, y1] = polygon[i];
    const [x2, y2] = polygon[(i + 1) % polygon.length];
    area += x1 * y2 - x2 * y1;
  }
  return Math.abs(area) / 2;
}

/** 把接近水平或垂直的邊拉直，重複數次讓相鄰房間的轉角對齊。 */
function orthogonalize(points: Vec2[]): Vec2[] {
  const out = points.map((point) => [...point] as Vec2);
  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 0; i < out.length; i += 1) {
      const j = (i + 1) % out.length;
      const dx = Math.abs(out[j][0] - out[i][0]);
      const dy = Math.abs(out[j][1] - out[i][1]);
      if (dx >= dy) {
        const y = (out[i][1] + out[j][1]) / 2;
        out[i][1] = y;
        out[j][1] = y;
      } else {
        const x = (out[i][0] + out[j][0]) / 2;
        out[i][0] = x;
        out[j][0] = x;
      }
    }
  }
  return out;
}

function snapAxes(polygons: Vec2[][], tolerance: number): Vec2[][] {
  const xs: { value: number; at: [number, number] }[] = [];
  const ys: { value: number; at: [number, number] }[] = [];
  polygons.forEach((polygon, polygonIndex) => {
    polygon.forEach((point, pointIndex) => {
      xs.push({ value: point[0], at: [polygonIndex, pointIndex] });
      ys.push({ value: point[1], at: [polygonIndex, pointIndex] });
    });
  });

  const snapped = polygons.map((polygon) => polygon.map((point) => [...point] as Vec2));
  for (const axis of [xs, ys] as const) {
    const coordinate = axis === xs ? 0 : 1;
    const sorted = [...axis].sort((a, b) => a.value - b.value);
    let group: typeof sorted = [];
    const flush = () => {
      if (group.length === 0) return;
      const average = group.reduce((sum, item) => sum + item.value, 0) / group.length;
      for (const item of group) {
        snapped[item.at[0]][item.at[1]][coordinate] = average;
      }
      group = [];
    };
    for (const item of sorted) {
      if (group.length > 0 && item.value - group[0].value > tolerance) flush();
      group.push(item);
    }
    flush();
  }
  return snapped;
}

function simplify(polygon: Vec2[]): Vec2[] {
  const next: Vec2[] = [];
  for (const point of polygon) {
    const last = next[next.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 2) {
      next.push(point);
    }
  }
  if (next.length >= 2) {
    const first = next[0];
    const last = next[next.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) <= 2) next.pop();
  }
  const cleaned: Vec2[] = [];
  for (let i = 0; i < next.length; i += 1) {
    const prev = next[(i + next.length - 1) % next.length];
    const point = next[i];
    const following = next[(i + 1) % next.length];
    const collinear =
      (Math.abs(prev[0] - point[0]) < 1.5 && Math.abs(point[0] - following[0]) < 1.5) ||
      (Math.abs(prev[1] - point[1]) < 1.5 && Math.abs(point[1] - following[1]) < 1.5);
    if (!collinear) cleaned.push(point);
  }
  return cleaned.length >= 3 ? cleaned : next;
}

/** 房間頂點落在另一道牆的中段時，把那道牆切開，隔間才會接到外牆。 */
function splitJunctions(polygons: Vec2[][], tolerance: number): Vec2[][] {
  const rooms = polygons.map((polygon) => polygon.map((point) => [...point] as Vec2));
  for (let guard = 0; guard < 6; guard += 1) {
    let changed = false;
    for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
      for (const vertex of rooms[roomIndex]) {
        for (let other = 0; other < rooms.length; other += 1) {
          const polygon = rooms[other];
          for (let edge = 0; edge < polygon.length; edge += 1) {
            const a = polygon[edge];
            const b = polygon[(edge + 1) % polygon.length];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const lengthSq = dx * dx + dy * dy;
            if (lengthSq < 16) continue;
            const t = ((vertex[0] - a[0]) * dx + (vertex[1] - a[1]) * dy) / lengthSq;
            if (t <= 0.04 || t >= 0.96) continue;
            const foot: Vec2 = [a[0] + dx * t, a[1] + dy * t];
            if (Math.hypot(vertex[0] - foot[0], vertex[1] - foot[1]) > tolerance) continue;
            if (Math.hypot(vertex[0] - a[0], vertex[1] - a[1]) <= tolerance) continue;
            if (Math.hypot(vertex[0] - b[0], vertex[1] - b[1]) <= tolerance) continue;
            polygon.splice(edge + 1, 0, [vertex[0], vertex[1]]);
            changed = true;
            break;
          }
        }
      }
    }
    if (!changed) break;
  }
  return rooms;
}

function edgeKey(a: Vec2, b: Vec2): string {
  const left = `${Math.round(a[0])},${Math.round(a[1])}`;
  const right = `${Math.round(b[0])},${Math.round(b[1])}`;
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function wallsFromRooms(rooms: Vec2[][]): FloorPlanWall[] {
  const count = new Map<string, { start: Vec2; end: Vec2; rooms: number }>();
  for (const room of rooms) {
    for (let i = 0; i < room.length; i += 1) {
      const start = room[i];
      const end = room[(i + 1) % room.length];
      if (Math.hypot(end[0] - start[0], end[1] - start[1]) < 4) continue;
      const key = edgeKey(start, end);
      const existing = count.get(key);
      if (existing) existing.rooms += 1;
      else count.set(key, { start, end, rooms: 1 });
    }
  }

  const horizontal: FloorPlanWall[] = [];
  const vertical: FloorPlanWall[] = [];
  for (const wall of count.values()) {
    const thickness = wall.rooms >= 2 ? 0.12 : 0.2;
    const piece: FloorPlanWall = { start: wall.start, end: wall.end, thickness };
    if (Math.abs(wall.start[1] - wall.end[1]) <= Math.abs(wall.start[0] - wall.end[0])) {
      horizontal.push(piece);
    } else {
      vertical.push(piece);
    }
  }
  return [...mergeColinear(horizontal, 0), ...mergeColinear(vertical, 1)];
}

function mergeColinear(walls: FloorPlanWall[], along: 0 | 1): FloorPlanWall[] {
  const groups = new Map<string, FloorPlanWall[]>();
  for (const wall of walls) {
    const fixed = Math.round((wall.start[1 - along] + wall.end[1 - along]) / 2);
    const key = `${wall.thickness}:${fixed}`;
    const list = groups.get(key) ?? [];
    list.push(wall);
    groups.set(key, list);
  }

  const merged: FloorPlanWall[] = [];
  for (const list of groups.values()) {
    const spans = list
      .map((wall) => {
        const from = Math.min(wall.start[along], wall.end[along]);
        const to = Math.max(wall.start[along], wall.end[along]);
        const fixed = (wall.start[1 - along] + wall.end[1 - along]) / 2;
        return { from, to, fixed, thickness: wall.thickness };
      })
      .sort((a, b) => a.from - b.from);

    let current = spans[0];
    for (const span of spans.slice(1)) {
      if (span.from <= current.to + 3) {
        current.to = Math.max(current.to, span.to);
      } else {
        merged.push(spanWall(current, along));
        current = span;
      }
    }
    if (current) merged.push(spanWall(current, along));
  }
  return merged;
}

function spanWall(
  span: { from: number; to: number; fixed: number; thickness: number },
  along: 0 | 1,
): FloorPlanWall {
  const start = [0, 0] as Vec2;
  const end = [0, 0] as Vec2;
  start[along] = span.from;
  end[along] = span.to;
  start[1 - along] = span.fixed;
  end[1 - along] = span.fixed;
  return { start, end, thickness: span.thickness };
}

function projectToWalls(
  point: Vec2,
  walls: FloorPlanWall[],
  maxDistance: number,
): { point: Vec2; rotation: number } | null {
  let best: { point: Vec2; rotation: number; distance: number } | null = null;
  for (const wall of walls) {
    const dx = wall.end[0] - wall.start[0];
    const dy = wall.end[1] - wall.start[1];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 16) continue;
    const t = ((point[0] - wall.start[0]) * dx + (point[1] - wall.start[1]) * dy) / lengthSq;
    if (t < 0 || t > 1) continue;
    const foot: Vec2 = [wall.start[0] + dx * t, wall.start[1] + dy * t];
    const distance = Math.hypot(point[0] - foot[0], point[1] - foot[1]);
    if (distance > maxDistance) continue;
    const rotation = Math.abs(dx) >= Math.abs(dy) ? 0 : Math.PI / 2;
    const score = distance - (wall.thickness < 0.16 ? maxDistance * 0.65 : 0);
    if (!best || score < best.distance) best = { point: foot, rotation, distance: score };
  }
  return best;
}

function chooseScale(raw: DetectedPlan, rooms: Vec2[][]): number {
  const reported = Number(raw.scale_info?.meters_per_pixel);
  if (raw.scale_info?.detected && reported >= 0.002 && reported <= 0.08) return reported;

  const points = rooms.flat();
  if (points.length === 0) return 0.01;
  const widthPx = Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0]));
  const heightPx = Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1]));
  const widthM = Number(raw.overall_dimensions?.width_meters);
  const heightM = Number(raw.overall_dimensions?.height_meters);
  const scales = [
    widthPx > 0 && widthM >= 4 && widthM <= 40 ? widthM / widthPx : 0,
    heightPx > 0 && heightM >= 4 && heightM <= 40 ? heightM / heightPx : 0,
  ].filter((scale) => scale > 0);
  if (scales.length === 0) return 0.01;
  return scales.reduce((sum, scale) => sum + scale, 0) / scales.length;
}

function scalePair(value: unknown, scaleX: number, scaleY: number): unknown {
  if (!Array.isArray(value) || value.length < 2 || Array.isArray(value[0])) return value;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return value;
  return [x * scaleX, y * scaleY];
}

function maxGridCoord(raw: DetectedPlan): number {
  let max = 0;
  for (const room of raw.detected_rooms ?? []) {
    if (!Array.isArray(room.polygon)) continue;
    for (const point of room.polygon) {
      if (!Array.isArray(point)) continue;
      max = Math.max(max, Number(point[0]) || 0, Number(point[1]) || 0);
    }
  }
  return max;
}

/** 模型照 0–100 格線回報時，換回裁切後平面圖的像素。已經是像素就不動。 */
export function fromGridCoordinates(
  raw: DetectedPlan,
  contentWidth: number,
  contentHeight: number,
): DetectedPlan {
  if (contentWidth < 8 || contentHeight < 8 || maxGridCoord(raw) > 140) return raw;
  const scaleX = contentWidth / 100;
  const scaleY = contentHeight / 100;
  const unit = Number(raw.scale_info?.meters_per_pixel);
  const unitScale = raw.scale_info?.detected && unit >= 0.03 && unit <= 0.8;
  return {
    ...raw,
    detected_rooms: raw.detected_rooms?.map((room) => ({
      ...room,
      polygon: Array.isArray(room.polygon)
        ? room.polygon.map((point) => scalePair(point, scaleX, scaleY))
        : room.polygon,
    })),
    detected_doors: raw.detected_doors?.map((door) => ({
      ...door,
      position: scalePair(door.position, scaleX, scaleY),
    })),
    detected_windows: raw.detected_windows?.map((window) => ({
      ...window,
      position: scalePair(window.position, scaleX, scaleY),
    })),
    scale_info: {
      detected: Boolean(unitScale),
      meters_per_pixel: unitScale ? unit / ((scaleX + scaleY) / 2) : 0.01,
    },
  };
}

/**
 * 依 Planova 的做法，把視覺模型的房間輪廓修成共用牆線的平面圖。
 * 傢俱留空，交給第二段佈局。
 */
export function repairDetectedPlan(raw: DetectedPlan): FloorPlan {
  const source = (raw.detected_rooms ?? [])
    .map((room) => ({
      name: (room.name || "").trim() || "房間",
      type: ROOM_TYPES[(room.type || "").trim()] ?? ROOM_TYPES[room.name?.trim() ?? ""] ?? "other",
      polygon: polygonOf(room.polygon),
    }))
    .filter((room) => room.polygon.length >= 3 && polygonArea(room.polygon) > 400);

  if (source.length === 0) {
    throw new Error("沒有辨識到房間輪廓，請換一張牆線更清楚的平面圖。");
  }

  const points = source.flatMap((room) => room.polygon);
  const span = Math.max(
    64,
    Math.max(...points.map((point) => point[0])) - Math.min(...points.map((point) => point[0])),
    Math.max(...points.map((point) => point[1])) - Math.min(...points.map((point) => point[1])),
  );
  const tolerance = Math.max(8, span * 0.012);

  const weldGap = Math.min(40, Math.max(28, span * 0.05));
  let polygons = source.map((room) => orthogonalize(room.polygon));
  polygons = snapAxes(polygons, tolerance);
  polygons = weldFacingEdges(polygons, weldGap);
  polygons = snapAxes(polygons, tolerance / 2);
  polygons = splitJunctions(polygons, tolerance);
  polygons = snapAxes(polygons, tolerance / 2).map(simplify);

  const rooms: FloorPlanRoom[] = source
    .map((room, index) => ({ name: room.name, type: room.type, polygon: polygons[index] }))
    .filter((room) => room.polygon.length >= 3 && polygonArea(room.polygon) > 400);

  const walls = wallsFromRooms(rooms.map((room) => room.polygon));
  if (walls.length < 4) {
    throw new Error("房間輪廓不足以組成牆面，請換一張平面圖再試。");
  }

  const scale = chooseScale(raw, rooms.map((room) => room.polygon));
  const snapDistance = Math.max(16, 0.55 / scale);
  const openings = (items: DetectedOpening[] | undefined, fallbackWidth: number): FloorPlanOpening[] =>
    (items ?? []).flatMap((item) => {
      const position = asPair(item.position);
      if (!position) return [];
      const snapped = projectToWalls(position, walls, snapDistance);
      if (!snapped) return [];
      const width = Number(item.width_meters ?? item.width);
      return [
        {
          position: snapped.point,
          rotation: snapped.rotation,
          width: Number.isFinite(width) && width > 0 ? width : fallbackWidth,
        },
      ];
    });

  return {
    walls,
    doors: connectRooms(rooms, openings(raw.detected_doors, 0.9), walls, scale),
    windows: openings(raw.detected_windows, 1.2),
    rooms,
    fixtures: [],
    scale,
    contradictions: (raw.contradictions ?? []).filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    ),
  };
}

interface SharedLink {
  a: number;
  b: number;
  mid: Vec2;
  from: number;
  to: number;
  fixed: number;
  horizontal: boolean;
  length: number;
}

function centroid(polygon: Vec2[]): Vec2 {
  const count = polygon.length || 1;
  return polygon.reduce(
    (sum, point) => [sum[0] + point[0] / count, sum[1] + point[1] / count] as Vec2,
    [0, 0] as Vec2,
  );
}

function edgeOverlap(
  a1: Vec2,
  a2: Vec2,
  b1: Vec2,
  b2: Vec2,
  maxGap: number,
): { mid: Vec2; from: number; to: number; fixed: number; horizontal: boolean; length: number; gap: number } | null {
  const aHorizontal = Math.abs(a2[0] - a1[0]) >= Math.abs(a2[1] - a1[1]);
  const bHorizontal = Math.abs(b2[0] - b1[0]) >= Math.abs(b2[1] - b1[1]);
  if (aHorizontal !== bHorizontal) return null;
  const along = aHorizontal ? 0 : 1;
  const fixed = aHorizontal ? 1 : 0;
  const gap = Math.abs((a1[fixed] + a2[fixed]) / 2 - (b1[fixed] + b2[fixed]) / 2);
  if (gap > maxGap) return null;
  const from = Math.max(Math.min(a1[along], a2[along]), Math.min(b1[along], b2[along]));
  const to = Math.min(Math.max(a1[along], a2[along]), Math.max(b1[along], b2[along]));
  if (to - from < 12) return null;
  const at = ((a1[fixed] + a2[fixed]) / 2 + (b1[fixed] + b2[fixed]) / 2) / 2;
  const mid = [0, 0] as Vec2;
  mid[along] = (from + to) / 2;
  mid[fixed] = at;
  return { mid, from, to, fixed: at, horizontal: aHorizontal, length: to - from, gap };
}

/** 兩房之間差一點沒重合的牆，拉成同一條線，避免變成兩道牆中間留一條走不過去的縫。 */
function weldFacingEdges(polygons: Vec2[][], maxGap: number): Vec2[][] {
  const rooms = polygons.map((polygon) => polygon.map((point) => [...point] as Vec2));
  for (let guard = 0; guard < 3; guard += 1) {
    let changed = false;
    for (let i = 0; i < rooms.length; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        for (let ei = 0; ei < rooms[i].length; ei += 1) {
          const a1 = rooms[i][ei];
          const a2 = rooms[i][(ei + 1) % rooms[i].length];
          for (let ej = 0; ej < rooms[j].length; ej += 1) {
            const b1 = rooms[j][ej];
            const b2 = rooms[j][(ej + 1) % rooms[j].length];
            const overlap = edgeOverlap(a1, a2, b1, b2, maxGap);
            if (!overlap || overlap.gap < 1.5) continue;
            const axis = overlap.horizontal ? 1 : 0;
            const sideA = centroid(rooms[i])[axis] - overlap.fixed;
            const sideB = centroid(rooms[j])[axis] - overlap.fixed;
            if (sideA * sideB >= 0) continue;
            const depth = (polygon: Vec2[]) =>
              Math.max(...polygon.map((point) => Math.abs(point[axis] - overlap.fixed)));
            if (depth(rooms[i]) < overlap.gap / 2 + 16 || depth(rooms[j]) < overlap.gap / 2 + 16) {
              continue;
            }
            a1[axis] = overlap.fixed;
            a2[axis] = overlap.fixed;
            b1[axis] = overlap.fixed;
            b2[axis] = overlap.fixed;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  return rooms;
}

function sharedLinks(rooms: FloorPlanRoom[]): SharedLink[] {
  const links: SharedLink[] = [];
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      let best: SharedLink | null = null;
      const left = rooms[i].polygon;
      const right = rooms[j].polygon;
      for (let ei = 0; ei < left.length; ei += 1) {
        for (let ej = 0; ej < right.length; ej += 1) {
          const overlap = edgeOverlap(
            left[ei],
            left[(ei + 1) % left.length],
            right[ej],
            right[(ej + 1) % right.length],
            10,
          );
          if (!overlap || (best && overlap.length <= best.length)) continue;
          best = { a: i, b: j, mid: overlap.mid, from: overlap.from, to: overlap.to, fixed: overlap.fixed, horizontal: overlap.horizontal, length: overlap.length };
        }
      }
      if (best) links.push(best);
    }
  }
  return links;
}

function doorOnLink(door: FloorPlanOpening, link: SharedLink): boolean {
  const along = link.horizontal ? door.position[0] : door.position[1];
  const cross = link.horizontal ? door.position[1] : door.position[0];
  return Math.abs(cross - link.fixed) < 16 && along >= link.from - 10 && along <= link.to + 10;
}

function hubIndex(rooms: FloorPlanRoom[]): number {
  let index = 0;
  let score = -1;
  rooms.forEach((room, roomIndex) => {
    if (room.type === "balcony") return;
    const rank =
      room.type === "living" || room.type === "corridor"
        ? 3
        : room.type === "dining" || room.type === "kitchen"
          ? 2
          : room.type === "bedroom"
            ? 1
            : 0;
    const next = rank * 1_000_000 + polygonArea(room.polygon);
    if (next > score) {
      score = next;
      index = roomIndex;
    }
  });
  return index;
}

function openingOnLink(link: SharedLink, rooms: FloorPlanRoom[], scale: number): FloorPlanOpening {
  const types = [rooms[link.a].type, rooms[link.b].type];
  const lengthM = link.length * scale;
  const width = types.includes("balcony") ? 1.5 : types.includes("bathroom") ? 0.75 : 0.9;
  return {
    position: link.mid,
    rotation: link.horizontal ? 0 : Math.PI / 2,
    width: Math.min(width, Math.max(0.6, lengthM * 0.72)),
  };
}

/**
 * 每一道隔間都留一扇門，不只補一條從客廳走進去的路。
 * 模型已經放在這道牆上的門會保留，不重複開。
 */
function connectRooms(
  rooms: FloorPlanRoom[],
  doors: FloorPlanOpening[],
  walls: FloorPlanWall[],
  scale: number,
): FloorPlanOpening[] {
  const result = [...doors];
  const links = sharedLinks(rooms).filter((link) => link.length * scale >= 0.7);
  for (const link of links) {
    if (result.some((door) => doorOnLink(door, link))) continue;
    result.push(openingOnLink(link, rooms, scale));
  }

  const onExterior = result.some((door) =>
    walls.some((wall) => wall.thickness >= 0.16 && projectToWalls(door.position, [wall], 14) !== null),
  );
  if (!onExterior) {
    const hub = rooms[hubIndex(rooms)];
    let entrance: { mid: Vec2; horizontal: boolean; score: number } | null = null;
    for (let i = 0; i < hub.polygon.length; i += 1) {
      const start = hub.polygon[i];
      const end = hub.polygon[(i + 1) % hub.polygon.length];
      const horizontal = Math.abs(end[0] - start[0]) >= Math.abs(end[1] - start[1]);
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (length * scale < 0.8) continue;
      const mid: Vec2 = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      const shared = links.some((link) => doorOnLink({ position: mid, rotation: 0, width: 0.9 }, link));
      if (shared) continue;
      const score = mid[1] + length * 0.05;
      if (!entrance || score > entrance.score) entrance = { mid, horizontal, score };
    }
    if (entrance) {
      result.push({
        position: entrance.mid,
        rotation: entrance.horizontal ? 0 : Math.PI / 2,
        width: 0.9,
      });
    }
  }

  return result;
}

function nearestRoom(name: string, point: Vec2 | null, rooms: FloorPlanRoom[]): FloorPlanRoom | null {
  const named = rooms.find((room) => room.name === name || room.name.includes(name) || name.includes(room.name));
  if (named) return named;
  if (!point) return null;
  return rooms.find((room) => pointInPolygon(point, room.polygon)) ?? null;
}

/**
 * 第二段傢俱座標是公尺、原點在圖片左上角。
 * 靠牆物件會貼到所屬房間的牆，並避開門口。
 */
export function applyFurniture(plan: FloorPlan, planned: PlannedFixture[]): FloorPlan {
  const fixtures: FloorPlanFixture[] = [];
  const doors = plan.doors.map((door) => door.position);

  for (const item of planned) {
    if (!FIXTURE_KINDS.includes(item.kind as FixtureKind)) continue;
    const kind = item.kind as FixtureKind;
    const meters = asPair(item.position);
    const hint = meters ? ([meters[0] / plan.scale, meters[1] / plan.scale] as Vec2) : null;
    const room = nearestRoom(item.room?.trim() || "", hint, plan.rooms);
    if (!room) continue;

    const size = FIXTURE_DEFAULT_SIZE[kind];
    const placed = WALL_BACKED.has(kind)
      ? snapInsideRoom(hint, room.polygon, size.depth, plan.scale, doors)
      : hint && pointInPolygon(hint, room.polygon)
        ? { position: hint, rotation: Number(item.rotation) || 0 }
        : null;
    if (!placed) continue;
    if (
      fixtures.some(
        (fixture) =>
          fixture.kind === kind &&
          Math.hypot(
            fixture.position[0] - placed.position[0],
            fixture.position[1] - placed.position[1],
          ) *
            plan.scale <
            0.8,
      )
    ) {
      continue;
    }
    fixtures.push({
      kind,
      position: placed.position,
      rotation: placed.rotation,
      width: size.width,
      depth: size.depth,
    });
  }

  return { ...plan, fixtures };
}

function snapInsideRoom(
  hint: Vec2 | null,
  polygon: Vec2[],
  depthM: number,
  scale: number,
  doors: Vec2[],
): { position: Vec2; rotation: number } | null {
  const center = polygon.reduce(
    (sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length] as Vec2,
    [0, 0] as Vec2,
  );
  const target = hint ?? center;
  const inset = (depthM / 2 + 0.08) / scale;
  const doorClearance = 0.75 / scale;
  let best: { position: Vec2; rotation: number; score: number } | null = null;

  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (length < 8) continue;
    let nx = -dy / length;
    let ny = dx / length;
    const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if (nx * (center[0] - mid[0]) + ny * (center[1] - mid[1]) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const t = Math.min(0.82, Math.max(0.18, ((target[0] - a[0]) * dx + (target[1] - a[1]) * dy) / (length * length)));
    const position: Vec2 = [a[0] + dx * t + nx * inset, a[1] + dy * t + ny * inset];
    if (!pointInPolygon(position, polygon)) continue;
    if (doors.some((door) => Math.hypot(position[0] - door[0], position[1] - door[1]) < doorClearance)) {
      continue;
    }
    const score = Math.hypot(position[0] - target[0], position[1] - target[1]);
    if (!best || score < best.score) {
      best = { position, rotation: Math.atan2(nx, -ny), score };
    }
  }
  return best;
}
