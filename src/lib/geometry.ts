import {
  FIXTURE_DEFAULT_SIZE,
  type FixtureKind,
  type FloorPlan,
} from "@/lib/parseFloorPlan";

/** 圖面沒標淨高時用的牆高（公尺）。這是假設，不是量到的淨高。 */
export const DEFAULT_WALL_HEIGHT_M = 2.8;
export const DOOR_HEIGHT_M = 2.1;
export const WINDOW_SILL_M = 0.9;
export const WINDOW_TOP_M = 2.1;
/** 1 坪 = 3.3058 平方公尺 */
export const SQUARE_METERS_PER_PING = 3.3058;

type Vec2 = [number, number];
type Vec3 = [number, number, number];

/** 一塊實心方塊，`size` 依序為長（沿牆）、高、厚。 */
export interface BoxPiece {
  center: Vec3;
  size: Vec3;
  rotationY: number;
}

export interface FloorPiece {
  name: string;
  type: string;
  color: string;
  /** 世界座標 [x, z] */
  points: Vec2[];
  labelAt: Vec2;
}

/** 走路碰撞用的牆段，`radius` 為半個牆厚。 */
export interface Collider {
  a: Vec2;
  b: Vec2;
  radius: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SceneFixture {
  kind: FixtureKind;
  position: Vec2;
  rotationY: number;
  width: number;
  depth: number;
  /** 所在房間類型，用來決定同一種物件的樣式（例如廚房與浴室的水槽） */
  roomType: string;
  /** 圖上沒有標出，依房間類型補上 */
  inferred: boolean;
}

export interface SceneOptions {
  wallHeight?: number;
  /** 使用者輸入的室內坪數；有值時用它校正整體比例 */
  ping?: number | null;
}

/** 2D 門符號：鉸鏈、沿牆方向、打開方向、門寬 */
export interface DoorSwing {
  hinge: Vec2;
  along: Vec2;
  open: Vec2;
  width: number;
}

export interface SceneGeometry {
  wallHeight: number;
  walls: BoxPiece[];
  glass: BoxPiece[];
  doorLeaves: BoxPiece[];
  doorSwings: DoorSwing[];
  floors: FloorPiece[];
  fixtures: SceneFixture[];
  /** 牆、窗與傢俱，走路時使用 */
  colliders: Collider[];
  /** 只有牆與窗，給小地圖和第三人稱鏡頭使用 */
  wallColliders: Collider[];
  bounds: Bounds;
  /** 目前場景的室內面積（坪） */
  ping: number;
  /** 比例來源：使用者坪數、模型比例尺，或自動估算 */
  scaleSource: "ping" | "model" | "estimated";
  spawn: Vec2;
  /** 出生點時朝向的點 */
  lookAt: Vec2;
  /** 找不到所屬牆的門窗數 */
  unmatchedOpenings: number;
  /** 依房間類型補上的傢俱與衛浴數量 */
  inferredFixtures: number;
}

const ROOM_COLORS: Record<string, string> = {
  living: "#d9c3a0",
  dining: "#d4b98f",
  kitchen: "#cfcfc6",
  bedroom: "#c9ae8c",
  bathroom: "#c7dbdc",
  balcony: "#b9c4ad",
  study: "#cfc4b4",
  corridor: "#d2cdc4",
  other: "#d6d2c8",
};

export function roomColor(type: string): string {
  return ROOM_COLORS[type] ?? ROOM_COLORS.other;
}

/** 沒有辨識結果時使用的示範格局（10m × 7m，一廳一房一衛）。 */
export const SAMPLE_FLOOR_PLAN: FloorPlan = {
  walls: [
    { start: [100, 100], end: [900, 100], thickness: 0.2 },
    { start: [900, 100], end: [900, 600], thickness: 0.2 },
    { start: [900, 600], end: [100, 600], thickness: 0.2 },
    { start: [100, 600], end: [100, 100], thickness: 0.2 },
    { start: [550, 100], end: [550, 600], thickness: 0.12 },
    { start: [550, 380], end: [900, 380], thickness: 0.12 },
  ],
  doors: [
    { position: [300, 600], rotation: 0, width: 1.0 },
    { position: [550, 250], rotation: Math.PI / 2, width: 0.9 },
    { position: [700, 380], rotation: 0, width: 0.8 },
  ],
  windows: [
    { position: [320, 100], rotation: 0, width: 1.8 },
    { position: [900, 240], rotation: Math.PI / 2, width: 1.2 },
    { position: [100, 350], rotation: Math.PI / 2, width: 1.5 },
  ],
  rooms: [
    {
      name: "客廳",
      type: "living",
      polygon: [
        [100, 100],
        [550, 100],
        [550, 600],
        [100, 600],
      ],
    },
    {
      name: "臥室",
      type: "bedroom",
      polygon: [
        [550, 100],
        [900, 100],
        [900, 380],
        [550, 380],
      ],
    },
    {
      name: "浴室",
      type: "bathroom",
      polygon: [
        [550, 380],
        [900, 380],
        [900, 600],
        [550, 600],
      ],
    },
  ],
  fixtures: [],
  scale: 0.01,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function polygonArea(points: Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    sum += x1 * z2 - x2 * z1;
  }
  return sum / 2;
}

function pointInPolygon([x, z]: Vec2, points: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonCenter(points: Vec2[]): Vec2 {
  const area = polygonArea(points);
  const average: Vec2 = [
    points.reduce((sum, [x]) => sum + x, 0) / points.length,
    points.reduce((sum, [, z]) => sum + z, 0) / points.length,
  ];
  if (Math.abs(area) < 1e-6) return average;

  let cx = 0;
  let cz = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x1, z1] = points[i];
    const [x2, z2] = points[(i + 1) % points.length];
    const cross = x1 * z2 - x2 * z1;
    cx += (x1 + x2) * cross;
    cz += (z1 + z2) * cross;
  }
  const centroid: Vec2 = [cx / (6 * area), cz / (6 * area)];
  return pointInPolygon(centroid, points) ? centroid : average;
}

/** 點到線段的距離（公尺）。 */
export function distanceToSegment([px, pz]: Vec2, [ax, az]: Vec2, [bx, bz]: Vec2) {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSq = dx * dx + dz * dz;
  const t =
    lengthSq === 0
      ? 0
      : clamp(((px - ax) * dx + (pz - az) * dz) / lengthSq, 0, 1);
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** 以 `radius` 的圓柱體站在 `point` 時，是否撞到任何牆。 */
export function hitsCollider(
  point: Vec2,
  colliders: Collider[],
  radius: number,
): boolean {
  return colliders.some(
    (collider) =>
      distanceToSegment(point, collider.a, collider.b) <
      collider.radius + radius,
  );
}

interface Opening {
  start: number;
  end: number;
  kind: "door" | "window";
}

/** 把靠得很近的牆端點和房間頂點收到同一個角點，讓轉角閉合。 */
function snapPoints(points: Vec2[], threshold: number): Vec2[] {
  const clusterOf = points.map(() => -1);
  const centers: Vec2[] = [];

  for (let i = 0; i < points.length; i += 1) {
    if (clusterOf[i] >= 0) continue;
    const cluster = [i];
    clusterOf[i] = centers.length;
    for (let j = i + 1; j < points.length; j += 1) {
      if (clusterOf[j] >= 0) continue;
      const distance = Math.hypot(
        points[i][0] - points[j][0],
        points[i][1] - points[j][1],
      );
      if (distance <= threshold) {
        clusterOf[j] = centers.length;
        cluster.push(j);
      }
    }
    centers.push([
      cluster.reduce((sum, index) => sum + points[index][0], 0) / cluster.length,
      cluster.reduce((sum, index) => sum + points[index][1], 0) / cluster.length,
    ]);
  }

  return points.map((_, index) => centers[clusterOf[index]]);
}

function angleDelta(a: number, b: number): number {
  const delta = Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  return Math.min(delta, Math.PI - delta);
}

const ROOM_FIXTURES: Partial<Record<string, FixtureKind[]>> = {
  bathroom: ["toilet", "sink", "shower"],
  bedroom: ["bed", "wardrobe"],
  living: ["sofa", "tv"],
  dining: ["dining_table"],
  kitchen: ["counter", "stove", "sink"],
  study: ["desk"],
};

function inwardNormal(a: Vec2, b: Vec2, toward: Vec2): Vec2 {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz) || 1;
  let nx = -dz / length;
  let nz = dx / length;
  const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (nx * (toward[0] - mid[0]) + nz * (toward[1] - mid[1]) < 0) {
    nx = -nx;
    nz = -nz;
  }
  return [nx, nz];
}

function overlapsFixture(
  point: Vec2,
  width: number,
  depth: number,
  fixtures: SceneFixture[],
): boolean {
  const own = Math.max(width, depth) * 0.5;
  return fixtures.some((fixture) => {
    const reach = Math.max(fixture.width, fixture.depth) * 0.5 + own * 0.9;
    return Math.hypot(point[0] - fixture.position[0], point[1] - fixture.position[1]) < reach;
  });
}

/** 旋轉 rotationY 後，物件本地 x 軸（寬）在平面上的方向。 */
function fixtureAxes(rotationY: number): { across: Vec2; front: Vec2 } {
  return {
    across: [Math.cos(rotationY), -Math.sin(rotationY)],
    front: [Math.sin(rotationY), Math.cos(rotationY)],
  };
}

/** 靠牆擺放的物件：背面貼牆、正面朝房內。 */
const WALL_BACKED: ReadonlySet<FixtureKind> = new Set<FixtureKind>([
  "bed",
  "sofa",
  "desk",
  "wardrobe",
  "tv",
  "toilet",
  "sink",
  "bathtub",
  "stove",
  "counter",
  "washer",
]);

const WALKABLE: ReadonlySet<FixtureKind> = new Set<FixtureKind>(["shower"]);

function fixtureCollider(fixture: SceneFixture): Collider {
  const { across, front } = fixtureAxes(fixture.rotationY);
  const alongWidth = fixture.width >= fixture.depth;
  const axis = alongWidth ? across : front;
  const long = alongWidth ? fixture.width : fixture.depth;
  const short = alongWidth ? fixture.depth : fixture.width;
  const half = Math.max(0, long / 2 - short / 2);
  return {
    a: [fixture.position[0] - axis[0] * half, fixture.position[1] - axis[1] * half],
    b: [fixture.position[0] + axis[0] * half, fixture.position[1] + axis[1] * half],
    radius: short / 2,
  };
}

function nearestCollider(point: Vec2, colliders: Collider[]) {
  let best: { collider: Collider; distance: number } | null = null;
  for (const collider of colliders) {
    const distance = distanceToSegment(point, collider.a, collider.b) - collider.radius;
    if (!best || distance < best.distance) best = { collider, distance };
  }
  return best;
}

function mergeOpenings(openings: Opening[]): Opening[] {
  const sorted = [...openings].sort((a, b) => a.start - b.start);
  const merged: Opening[] = [];
  for (const opening of sorted) {
    const last = merged[merged.length - 1];
    if (last && opening.start <= last.end) {
      last.end = Math.max(last.end, opening.end);
      if (opening.kind === "door") last.kind = "door";
    } else {
      merged.push({ ...opening });
    }
  }
  return merged;
}

/** 把平面圖 JSON（像素座標）轉成以公尺為單位、置中於原點的 3D 幾何。 */
export function buildSceneGeometry(
  plan: FloorPlan,
  options: SceneOptions = {},
): SceneGeometry {
  const wallHeight = options.wallHeight ?? DEFAULT_WALL_HEIGHT_M;
  const rawPoints: Vec2[] = [
    ...plan.walls.flatMap((wall) => [wall.start, wall.end]),
    ...plan.rooms.flatMap((room) => room.polygon),
  ];
  const rawExtent = rawPoints.length
    ? Math.max(
        Math.max(...rawPoints.map(([x]) => x)) - Math.min(...rawPoints.map(([x]) => x)),
        Math.max(...rawPoints.map(([, y]) => y)) - Math.min(...rawPoints.map(([, y]) => y)),
      )
    : 0;
  const snapped = snapPoints(rawPoints, Math.max(12, rawExtent * 0.02));
  let snapCursor = 0;
  const sourceWalls = plan.walls.map((wall) => ({
    ...wall,
    start: snapped[snapCursor++] ?? wall.start,
    end: snapped[snapCursor++] ?? wall.end,
  }));
  const sourceRooms = plan.rooms.map((room) => ({
    ...room,
    polygon: room.polygon.map((point) => snapped[snapCursor++] ?? point),
  }));

  const pixelPoints: Vec2[] = [
    ...sourceWalls.flatMap((wall) => [wall.start, wall.end]),
    ...sourceRooms.flatMap((room) => room.polygon),
  ];

  const pxMinX = Math.min(...pixelPoints.map(([x]) => x));
  const pxMaxX = Math.max(...pixelPoints.map(([x]) => x));
  const pxMinY = Math.min(...pixelPoints.map(([, y]) => y));
  const pxMaxY = Math.max(...pixelPoints.map(([, y]) => y));
  const hasPoints = pixelPoints.length > 0;
  const extentPx = hasPoints ? Math.max(pxMaxX - pxMinX, pxMaxY - pxMinY) : 0;

  const roomAreaPx = sourceRooms.reduce(
    (sum, room) => sum + Math.abs(polygonArea(room.polygon)),
    0,
  );
  const areaPx =
    roomAreaPx > 0
      ? roomAreaPx
      : hasPoints
        ? (pxMaxX - pxMinX) * (pxMaxY - pxMinY)
        : 0;

  let scale = plan.scale;
  let scaleSource: SceneGeometry["scaleSource"] = "model";
  const targetPing = options.ping;
  if (targetPing && targetPing > 0 && areaPx > 0) {
    scale = Math.sqrt((targetPing * SQUARE_METERS_PER_PING) / areaPx);
    scaleSource = "ping";
  } else {
    const extentM = extentPx * scale;
    if (extentPx > 0 && (extentM < 4 || extentM > 60)) {
      scale = 12 / extentPx;
      scaleSource = "estimated";
    }
  }
  const ping = (areaPx * scale * scale) / SQUARE_METERS_PER_PING;

  const centerX = hasPoints ? (pxMinX + pxMaxX) / 2 : 0;
  const centerY = hasPoints ? (pxMinY + pxMaxY) / 2 : 0;
  const toWorld = ([x, y]: Vec2): Vec2 => [
    (x - centerX) * scale,
    (y - centerY) * scale,
  ];

  const doorTop = Math.min(DOOR_HEIGHT_M, wallHeight - 0.1);
  const windowTop = Math.min(WINDOW_TOP_M, wallHeight - 0.1);

  const walls = sourceWalls
    .map((wall) => {
      const a = toWorld(wall.start);
      const b = toWorld(wall.end);
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u: Vec2 =
        length > 0 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : [1, 0];
      return {
        a,
        u,
        length,
        thickness: clamp(wall.thickness, 0.05, 0.5),
        openings: [] as Opening[],
      };
    })
    .filter((wall) => wall.length > 0.05);

  let unmatchedOpenings = 0;
  const openings = [
    ...plan.doors.map((door) => ({ ...door, kind: "door" as const })),
    ...plan.windows.map((window) => ({ ...window, kind: "window" as const })),
  ];

  for (const opening of openings) {
    const p = toWorld(opening.position);
    let best: {
      wall: (typeof walls)[number];
      t: number;
      score: number;
    } | null = null;

    for (const wall of walls) {
      const rx = p[0] - wall.a[0];
      const rz = p[1] - wall.a[1];
      const t = rx * wall.u[0] + rz * wall.u[1];
      const distance = Math.abs(rx * wall.u[1] - rz * wall.u[0]);
      const tolerance = Math.max(0.9, wall.thickness * 3);
      if (t < -0.3 || t > wall.length + 0.3 || distance > tolerance) continue;
      const alignment = angleDelta(Math.atan2(wall.u[1], wall.u[0]), opening.rotation);
      const score = distance + alignment * 1.4;
      if (!best || score < best.score) best = { wall, t, score };
    }

    const width = clamp(opening.width, 0.4, 4);
    if (!best) {
      unmatchedOpenings += 1;
      continue;
    }
    const start = clamp(best.t - width / 2, 0, best.wall.length);
    const end = clamp(best.t + width / 2, 0, best.wall.length);
    if (end - start < 0.2) {
      unmatchedOpenings += 1;
      continue;
    }
    best.wall.openings.push({ start, end, kind: opening.kind });
  }

  const roomPolys = sourceRooms.map((room) => room.polygon.map(toWorld));
  const swings: Array<DoorSwing & { host: (typeof walls)[number] }> = [];
  for (const wall of walls) {
    for (const opening of mergeOpenings(wall.openings)) {
      if (opening.kind !== "door") continue;
      const width = opening.end - opening.start;
      if (width < 0.2) continue;
      const mid: Vec2 = [
        wall.a[0] + wall.u[0] * ((opening.start + opening.end) / 2),
        wall.a[1] + wall.u[1] * ((opening.start + opening.end) / 2),
      ];
      let open: Vec2 = [-wall.u[1], wall.u[0]];
      const probe: Vec2 = [mid[0] + open[0] * 0.4, mid[1] + open[1] * 0.4];
      if (!roomPolys.some((poly) => pointInPolygon(probe, poly))) {
        open = [-open[0], -open[1]];
      }
      swings.push({
        hinge: [
          wall.a[0] + wall.u[0] * (opening.start + 0.02),
          wall.a[1] + wall.u[1] * (opening.start + 0.02),
        ],
        along: wall.u,
        open,
        width,
        host: wall,
      });
    }
  }

  const wallPieces: BoxPiece[] = [];
  const glass: BoxPiece[] = [];
  const doorLeaves: BoxPiece[] = [];
  const colliders: Collider[] = [];
  const doorways: Vec2[] = [];

  for (const wall of walls) {
    const rotationY = Math.atan2(-wall.u[1], wall.u[0]);
    const at = (t: number): Vec2 => [
      wall.a[0] + wall.u[0] * t,
      wall.a[1] + wall.u[1] * t,
    ];
    const addBox = (
      target: BoxPiece[],
      from: number,
      to: number,
      bottom: number,
      top: number,
      thickness = wall.thickness,
    ) => {
      if (to - from < 0.01 || top - bottom < 0.01) return;
      const [x, z] = at((from + to) / 2);
      target.push({
        center: [x, (bottom + top) / 2, z],
        size: [to - from, top - bottom, thickness],
        rotationY,
      });
    };
    const addCollider = (from: number, to: number) => {
      colliders.push({ a: at(from), b: at(to), radius: wall.thickness / 2 });
    };
    const inDoorArc = (from: number, to: number) => {
      const length = to - from;
      const mid = at((from + to) / 2);
      return swings.some((swing) => {
        if (swing.host === wall || length > swing.width * 1.35) return false;
        const dx = mid[0] - swing.hinge[0];
        const dz = mid[1] - swing.hinge[1];
        const dist = Math.hypot(dx, dz);
        if (dist > swing.width * 0.98 || dist < 0.05) return false;
        const into = dx * swing.open[0] + dz * swing.open[1];
        const forward = dx * swing.along[0] + dz * swing.along[1];
        return into > swing.width * 0.12 && forward > -swing.width * 0.08;
      });
    };
    const addSolid = (from: number, to: number) => {
      if (inDoorArc(from, to)) return;
      addBox(wallPieces, from, to, 0, wallHeight);
      addCollider(from, to);
    };

    const half = wall.thickness / 2;
    let cursor = -half;
    for (const opening of mergeOpenings(wall.openings)) {
      addSolid(cursor, opening.start);

      if (opening.kind === "door") {
        addBox(wallPieces, opening.start, opening.end, doorTop, wallHeight);
        const width = opening.end - opening.start;
        const hingeAt = at(opening.start + 0.02);
        const swing = swings.find(
          (item) =>
            item.host === wall &&
            Math.hypot(item.hinge[0] - hingeAt[0], item.hinge[1] - hingeAt[1]) < 0.2,
        );
        const normal = swing?.open ?? ([-wall.u[1], wall.u[0]] as Vec2);
        doorways.push(at((opening.start + opening.end) / 2));
        const hinge = swing?.hinge ?? at(opening.start + 0.02);
        const face = wall.thickness / 2 + 0.02;
        doorLeaves.push({
          center: [
            hinge[0] + normal[0] * (face + width / 2),
            doorTop / 2,
            hinge[1] + normal[1] * (face + width / 2),
          ],
          size: [Math.max(0.2, width - 0.04), doorTop - 0.02, 0.035],
          rotationY: Math.atan2(-normal[1], normal[0]),
        });
      } else {
        addBox(wallPieces, opening.start, opening.end, 0, WINDOW_SILL_M);
        addBox(wallPieces, opening.start, opening.end, windowTop, wallHeight);
        addBox(
          glass,
          opening.start,
          opening.end,
          WINDOW_SILL_M,
          windowTop,
          0.02,
        );
        addCollider(opening.start, opening.end);
      }
      cursor = opening.end;
    }
    addSolid(cursor, wall.length + half);
  }

  const floors: FloorPiece[] = sourceRooms.map((room) => {
    const points = room.polygon.map(toWorld);
    return {
      name: room.name,
      type: room.type,
      color: roomColor(room.type),
      points,
      labelAt: polygonCenter(points),
    };
  });

  const worldPoints: Vec2[] = [
    ...walls.flatMap((wall) => [wall.a, [
      wall.a[0] + wall.u[0] * wall.length,
      wall.a[1] + wall.u[1] * wall.length,
    ] as Vec2]),
    ...floors.flatMap((floor) => floor.points),
  ];
  const bounds: Bounds = worldPoints.length
    ? {
        minX: Math.min(...worldPoints.map(([x]) => x)),
        maxX: Math.max(...worldPoints.map(([x]) => x)),
        minZ: Math.min(...worldPoints.map(([, z]) => z)),
        maxZ: Math.max(...worldPoints.map(([, z]) => z)),
      }
    : { minX: -5, maxX: 5, minZ: -5, maxZ: 5 };

  const wallColliders = [...colliders];
  const roomTypeAt = (point: Vec2) =>
    floors.find((floor) => pointInPolygon(point, floor.points))?.type ?? "other";
  const nearDoorway = (point: Vec2, reach: number) =>
    doorways.some(
      (door) => Math.hypot(point[0] - door[0], point[1] - door[1]) < reach,
    );

  const fixtures: SceneFixture[] = [];
  for (const fixture of plan.fixtures ?? []) {
    const size = FIXTURE_DEFAULT_SIZE[fixture.kind];
    const width = clamp(fixture.width, size.width * 0.7, size.width * 1.3);
    const depth = clamp(fixture.depth, size.depth * 0.7, size.depth * 1.3);
    let position = toWorld(fixture.position);
    if (!floors.some((floor) => pointInPolygon(position, floor.points))) continue;
    let rotationY = Math.PI - fixture.rotation;

    if (WALL_BACKED.has(fixture.kind)) {
      const nearest = nearestCollider(position, wallColliders);
      if (nearest && nearest.distance < depth / 2 + 0.28) {
        const { a, b } = nearest.collider;
        const dx = b[0] - a[0];
        const dz = b[1] - a[1];
        const length = Math.hypot(dx, dz) || 1;
        const t = clamp(
          ((position[0] - a[0]) * dx + (position[1] - a[1]) * dz) / (length * length),
          0,
          1,
        );
        const foot: Vec2 = [a[0] + dx * t, a[1] + dz * t];
        let nx = -dz / length;
        let nz = dx / length;
        if (nx * (position[0] - foot[0]) + nz * (position[1] - foot[1]) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const offset = nearest.collider.radius + depth / 2 + 0.02;
        position = [foot[0] + nx * offset, foot[1] + nz * offset];
        rotationY = Math.atan2(nx, nz);
      }
    }

    fixtures.push({
      kind: fixture.kind,
      position,
      rotationY,
      width,
      depth,
      roomType: roomTypeAt(position),
      inferred: false,
    });
  }

  for (const floor of floors) {
    const wanted = ROOM_FIXTURES[floor.type] ?? [];
    const center = floor.labelAt;
    const edges = floor.points.map((point, index) => {
      const next = floor.points[(index + 1) % floor.points.length];
      return { a: point, b: next, length: Math.hypot(next[0] - point[0], next[1] - point[1]) };
    });

    for (const kind of wanted) {
      if (fixtures.some((fixture) => fixture.kind === kind && pointInPolygon(fixture.position, floor.points))) {
        continue;
      }
      const size = FIXTURE_DEFAULT_SIZE[kind];
      let placed: SceneFixture | null = null;

      for (const edge of [...edges].sort((a, b) => b.length - a.length)) {
        if (placed) break;
        const normal = inwardNormal(edge.a, edge.b, center);
        const width = Math.min(size.width, Math.max(0.4, edge.length - 0.4));
        for (const ratio of [0.5, 0.32, 0.68]) {
          const along: Vec2 = [
            edge.a[0] + (edge.b[0] - edge.a[0]) * ratio,
            edge.a[1] + (edge.b[1] - edge.a[1]) * ratio,
          ];
          const position: Vec2 = [
            along[0] + normal[0] * (size.depth / 2 + 0.12),
            along[1] + normal[1] * (size.depth / 2 + 0.12),
          ];
          if (
            !pointInPolygon(position, floor.points) ||
            hitsCollider(position, wallColliders, Math.min(width, size.depth) / 2 - 0.02) ||
            overlapsFixture(position, width, size.depth, fixtures) ||
            nearDoorway(position, Math.max(width, size.depth) / 2 + 0.75)
          ) {
            continue;
          }
          placed = {
            kind,
            position,
            rotationY: Math.atan2(normal[0], normal[1]),
            width,
            depth: size.depth,
            roomType: floor.type,
            inferred: true,
          };
          break;
        }
      }

      if (placed) fixtures.push(placed);
    }
  }

  for (const fixture of fixtures) {
    if (!WALKABLE.has(fixture.kind)) colliders.push(fixtureCollider(fixture));
  }

  const startRoom =
    floors.find((floor) => floor.type === "living") ??
    [...floors].sort(
      (a, b) => Math.abs(polygonArea(b.points)) - Math.abs(polygonArea(a.points)),
    )[0];
  let spawn: Vec2 = startRoom
    ? startRoom.labelAt
    : [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2];

  if (hitsCollider(spawn, colliders, 0.35)) {
    const room = startRoom?.points;
    const candidates: Vec2[] = [];
    for (let i = 1; i <= 12; i += 1) {
      for (let k = 0; k < 12; k += 1) {
        const angle = (k / 12) * Math.PI * 2;
        candidates.push([
          spawn[0] + Math.cos(angle) * i * 0.25,
          spawn[1] + Math.sin(angle) * i * 0.25,
        ]);
      }
    }
    const free = candidates.find(
      (point) =>
        !hitsCollider(point, colliders, 0.35) &&
        (!room || pointInPolygon(point, room)),
    );
    if (free) spawn = free;
  }

  const maxView = Math.hypot(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
  const insideHome = (point: Vec2) =>
    floors.some((floor) => pointInPolygon(point, floor.points));
  let lookAt: Vec2 = [spawn[0], spawn[1] - 1];
  let longestView = -1;
  for (let k = 0; k < 16; k += 1) {
    const angle = (k / 16) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    let distance = 0;
    while (
      distance < maxView &&
      insideHome([
        spawn[0] + dx * (distance + 0.15),
        spawn[1] + dz * (distance + 0.15),
      ]) &&
      !hitsCollider(
        [spawn[0] + dx * (distance + 0.1), spawn[1] + dz * (distance + 0.1)],
        wallColliders,
        0.05,
      )
    ) {
      distance += 0.1;
    }
    if (distance > longestView) {
      longestView = distance;
      lookAt = [spawn[0] + dx, spawn[1] + dz];
    }
  }

  return {
    wallHeight,
    walls: wallPieces,
    glass,
    doorLeaves,
    doorSwings: swings.map(({ hinge, along, open, width }) => ({
      hinge,
      along,
      open,
      width,
    })),
    floors,
    fixtures,
    colliders,
    wallColliders,
    bounds,
    ping,
    scaleSource,
    spawn,
    lookAt,
    unmatchedOpenings,
    inferredFixtures: fixtures.filter((fixture) => fixture.inferred).length,
  };
}
