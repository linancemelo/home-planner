/** 牆段。座標原點為圖片左上角，單位為像素。 */
export interface FloorPlanWall {
  start: [number, number];
  end: [number, number];
  /** 牆厚（公尺） */
  thickness: number;
}

/** 門或窗。 */
export interface FloorPlanOpening {
  position: [number, number];
  /** 繞垂直軸的旋轉（弧度） */
  rotation: number;
  /** 開口寬度（公尺） */
  width: number;
}

export interface FloorPlanRoom {
  name: string;
  type: string;
  polygon: [number, number][];
}

export const FIXTURE_KINDS = [
  "bed",
  "sofa",
  "dining_table",
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
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/** 傢俱或衛浴。座標為平面圖像素，寬深為公尺。 */
export interface FloorPlanFixture {
  kind: FixtureKind;
  position: [number, number];
  /** 正面朝向的弧度：0 朝圖片上方，順時針增加 */
  rotation: number;
  width: number;
  depth: number;
}

/** AI 辨識後的平面圖。`scale` 把像素換成公尺。 */
export interface FloorPlan {
  walls: FloorPlanWall[];
  doors: FloorPlanOpening[];
  windows: FloorPlanOpening[];
  rooms: FloorPlanRoom[];
  fixtures: FloorPlanFixture[];
  scale: number;
  /** 圖面尺寸或格局互相矛盾時的說明。沒有衝突就是空陣列。 */
  contradictions?: string[];
}

export type FloorPlanStatus = "waiting" | "analyzing" | "done" | "error";

export const FLOOR_PLAN_STATUS_LABEL: Record<FloorPlanStatus, string> = {
  waiting: "等待上傳",
  analyzing: "辨識中",
  done: "完成",
  error: "辨識失敗",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseWalls(value: unknown): FloorPlanWall[] {
  if (!Array.isArray(value)) {
    throw new Error("平面圖 JSON 缺少 walls");
  }
  return value.flatMap((item) => {
    const wall = asRecord(item);
    if (!wall) return [];
    const start = pair(wall.start);
    const end = pair(wall.end);
    if (!start || !end) return [];
    return [
      {
        start,
        end,
        thickness: finiteNumber(wall.thickness, 0.15),
      },
    ];
  });
}

function parseOpenings(
  value: unknown,
  field: "doors" | "windows",
  defaultWidth: number,
): FloorPlanOpening[] {
  if (!Array.isArray(value)) {
    throw new Error(`平面圖 JSON 缺少 ${field}`);
  }
  return value.flatMap((item) => {
    const opening = asRecord(item);
    if (!opening) return [];
    const position = pair(opening.position);
    if (!position) return [];
    return [
      {
        position,
        rotation: finiteNumber(opening.rotation, 0),
        width: finiteNumber(opening.width, defaultWidth),
      },
    ];
  });
}

const ROOM_TYPES: Record<string, string> = {
  living: "living",
  dining: "dining",
  kitchen: "kitchen",
  bedroom: "bedroom",
  bathroom: "bathroom",
  balcony: "balcony",
  study: "study",
  corridor: "corridor",
  書房: "study",
  走道: "corridor",
  other: "other",
  客廳: "living",
  餐廳: "dining",
  廚房: "kitchen",
  臥室: "bedroom",
  主臥: "bedroom",
  次臥: "bedroom",
  浴室: "bathroom",
  衛浴: "bathroom",
  廁所: "bathroom",
  陽台: "balcony",
  陽臺: "balcony",
  bath: "bathroom",
  wc: "bathroom",
};

const FIXTURE_KIND_SET = new Set<string>(FIXTURE_KINDS);

export const FIXTURE_DEFAULT_SIZE: Record<
  FixtureKind,
  { width: number; depth: number }
> = {
  bed: { width: 1.6, depth: 2.05 },
  sofa: { width: 2.1, depth: 0.9 },
  dining_table: { width: 1.4, depth: 0.85 },
  desk: { width: 1.2, depth: 0.6 },
  wardrobe: { width: 1.6, depth: 0.6 },
  tv: { width: 1.6, depth: 0.42 },
  toilet: { width: 0.4, depth: 0.7 },
  sink: { width: 0.6, depth: 0.48 },
  bathtub: { width: 1.6, depth: 0.75 },
  shower: { width: 0.9, depth: 0.9 },
  stove: { width: 0.6, depth: 0.6 },
  counter: { width: 2.2, depth: 0.6 },
  washer: { width: 0.6, depth: 0.6 },
};

function parseRooms(value: unknown): FloorPlanRoom[] {
  if (!Array.isArray(value)) {
    throw new Error("平面圖 JSON 缺少 rooms");
  }
  return value.flatMap((item) => {
    const room = asRecord(item);
    if (!room || !Array.isArray(room.polygon)) return [];
    const polygon = room.polygon.flatMap((point) => {
      const parsed = pair(point);
      return parsed ? [parsed] : [];
    });
    if (polygon.length < 3) return [];
    const name =
      typeof room.name === "string" && room.name.trim()
        ? room.name.trim()
        : "未命名";
    const rawType =
      typeof room.type === "string" ? room.type.trim().toLowerCase() : "";
    const type = ROOM_TYPES[rawType] ?? ROOM_TYPES[name] ?? "other";
    return [{ name, type, polygon }];
  });
}

function parseFixtures(value: unknown): FloorPlanFixture[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new Error("平面圖 JSON 缺少 fixtures");
  }
  return value.flatMap((item) => {
    const fixture = asRecord(item);
    if (!fixture) return [];
    const kind = typeof fixture.kind === "string" ? fixture.kind : fixture.type;
    if (typeof kind !== "string" || !FIXTURE_KIND_SET.has(kind)) return [];
    const position = pair(fixture.position);
    if (!position) return [];
    const size = FIXTURE_DEFAULT_SIZE[kind as FixtureKind];
    return [
      {
        kind: kind as FixtureKind,
        position,
        rotation: finiteNumber(fixture.rotation, 0),
        width: finiteNumber(fixture.width, size.width),
        depth: finiteNumber(fixture.depth, size.depth),
      },
    ];
  });
}

function unwrapJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const text = fenced?.[1]?.trim() || trimmed;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型沒有回傳 JSON");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("模型回傳的 JSON 不完整");
  }
}

/** 把模型文字或已解析物件收成 FloorPlan。格式不對時丟出錯誤。 */
export function parseFloorPlan(raw: unknown): FloorPlan {
  const data = typeof raw === "string" ? unwrapJson(raw) : raw;
  const plan = asRecord(data);
  if (!plan) {
    throw new Error("平面圖 JSON 格式不正確");
  }

  const scale = Number(plan.scale);
  return {
    walls: parseWalls(plan.walls),
    doors: parseOpenings(plan.doors, "doors", 0.9),
    windows: parseOpenings(plan.windows, "windows", 1.2),
    rooms: parseRooms(plan.rooms),
    fixtures: parseFixtures(plan.fixtures),
    scale: Number.isFinite(scale) && scale > 0 ? scale : 0.01,
    contradictions: Array.isArray(plan.contradictions)
      ? plan.contradictions.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [],
  };
}
