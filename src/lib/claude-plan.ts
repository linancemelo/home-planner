import type {
  TracedDoor,
  TracedPlan,
  TracedSegment,
  TracedWindow,
} from "@/lib/trace-floor-plan";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

const REQUEST_TIMEOUT_MS = 85_000;
/** Claude 單張圖片 base64 上限約 5 MB。 */
const MAX_IMAGE_BASE64 = 5_000_000;

const POINT = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: {
    x: { type: "number" },
    y: { type: "number" },
  },
};

const WALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["walls", "doors", "windows"],
  properties: {
    walls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "kind"],
        properties: {
          start: POINT,
          end: POINT,
          kind: { type: "string", enum: ["exterior", "partition"] },
        },
      },
    },
    doors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hinge", "latch", "swing_to", "kind"],
        properties: {
          hinge: POINT,
          latch: POINT,
          swing_to: POINT,
          kind: { type: "string", enum: ["swing", "sliding"] },
        },
      },
    },
    windows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end"],
        properties: {
          start: POINT,
          end: POINT,
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `你是建築平面圖描圖員。只描牆、門、窗，其他都不要。
圖已裁成平面圖本體，並畫了紅色 0–100 座標格。左上角是 (0,0)，x 向右到 100，y 向下到 100。所有座標都用這個格線，不要用像素，也不要把格線外的數字標籤算進去。

忽略：傢俱、櫃體、衛浴設備、地板材質、植栽、文字、尺寸線與刻度、指北針、圖例、浮水印、陰影。樓梯只描外圍的牆。

walls：
- 每一道牆一條中心線，start、end 是兩端。牆幾乎都是水平或垂直，請讓它真的水平或垂直。
- 外牆 kind 填 exterior，要連成閉合外框，保留內縮與外凸，不要修成大矩形。室內隔間填 partition，臥室、浴室、廚房、儲藏室的牆都要列。
- 相接的牆端點座標要相同。牆在門洞、窗洞處要斷開，不要穿過開口。
- 雙線或填實的粗線才是牆。單一細線通常是傢俱或標註，不要當牆。

doors：
- 平開門是牆上的缺口，加一條細線（門片）和一段四分之一圓弧。圓弧和門片都不是牆。
- hinge 是門軸那一端的缺口端點，latch 是缺口另一端，兩點都在牆的中心線上。swing_to 是門打開 90 度時門片末端的位置，也就是圓弧的另一端，用來表示往哪一側開。kind 填 swing。
- 推拉門是缺口裡兩條錯開的平行線，沒有圓弧。kind 填 sliding，hinge、latch 是缺口兩端，swing_to 填和 hinge 相同的點。
- 每一扇門都要列，包含入戶門、房門、浴室門、陽台門。

windows：
- 窗在外牆上，通常是牆線中斷後的兩到三條平行細線，沒有圓弧。start、end 是窗洞兩端，在牆的中心線上。
- 有圓弧的是門，不要標成窗。

看不清楚的部分寧可少列，不要猜。`;

export interface ClaudeWallPlan {
  walls: { start: Point; end: Point; kind: "exterior" | "partition" }[];
  doors: { hinge: Point; latch: Point; swing_to: Point; kind: "swing" | "sliding" }[];
  windows: { start: Point; end: Point }[];
}

interface Point {
  x: number;
  y: number;
}

interface ClaudeResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

/**
 * 用 Claude 看平面圖，只取回牆、門、窗，再換成平面圖內容的像素座標。
 * 只能在伺服器呼叫，避免 API key 進到瀏覽器。
 */
export async function analyzeWallsWithClaude(
  imageDataUrl: string,
  size: { contentWidth: number; contentHeight: number },
): Promise<{ plan: TracedPlan; raw: ClaudeWallPlan; model: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("尚未設定 ANTHROPIC_API_KEY。請在 .env.local 填入你的 Claude API Key。");
  }
  const matched = imageDataUrl.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
  if (!matched) throw new Error("只接受 JPG 或 PNG");
  if (matched[2].length > MAX_IMAGE_BASE64) {
    throw new Error("圖片太大，請換一張較小的平面圖");
  }

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_MODEL;
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: matched[1], data: matched[2] },
              },
              {
                type: "text",
                text: "描出這張平面圖的牆、門、窗。座標用 0 到 100 的格線。只回傳 JSON。",
              },
            ],
          },
        ],
        output_config: {
          format: { type: "json_schema", schema: WALL_SCHEMA },
        },
      }),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error("Claude 回應逾時，請稍後再試。");
    }
    throw err;
  }

  const body = (await response.json().catch(() => ({}))) as ClaudeResponse;
  if (!response.ok) throw new Error(claudeErrorMessage(response.status, body));
  if (body.stop_reason === "refusal") throw new Error("Claude 無法分析這張圖片");
  if (body.stop_reason === "max_tokens") {
    throw new Error("模型回傳被截斷，請換一張較簡單的平面圖再試");
  }
  const text = (body.content ?? [])
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) throw new Error("模型沒有回傳內容");

  const raw = JSON.parse(text) as ClaudeWallPlan;
  return {
    plan: toTracedPlan(raw, size.contentWidth, size.contentHeight),
    raw,
    model,
  };
}

function claudeErrorMessage(status: number, body: ClaudeResponse): string {
  const raw = body.error?.message?.trim() || `Claude 回應 ${status}`;
  if (status === 401 || status === 403) return "Claude API Key 無效或沒有權限。";
  if (status === 404) {
    return `找不到模型。請確認 .env.local 的 ANTHROPIC_MODEL。${raw}`;
  }
  if (status === 429) return "Claude 用量達到上限，請稍後再試。";
  if (status === 529 || status === 503) return "Claude 目前忙碌，請稍後再試。";
  return raw;
}

function toTracedPlan(raw: ClaudeWallPlan, width: number, height: number): TracedPlan {
  const span = Math.max(width, height);
  const toPx = (point: Point) => ({
    x: (clamp(point.x) / 100) * width,
    y: (clamp(point.y) / 100) * height,
  });
  const exterior = Math.max(6, Math.round(span * 0.012));
  const partition = Math.max(4, Math.round(span * 0.007));

  let walls: TracedSegment[] = (raw.walls ?? [])
    .filter((wall) => isPoint(wall.start) && isPoint(wall.end))
    .map((wall) => {
      const a = toPx(wall.start);
      const b = toPx(wall.end);
      return straighten({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        thickness: wall.kind === "exterior" ? exterior : partition,
      });
    })
    .filter((wall) => Math.hypot(wall.x2 - wall.x1, wall.y2 - wall.y1) >= 2);
  walls = snapToWalls(weldEndpoints(walls, Math.max(4, span * 0.012)), Math.max(4, span * 0.012));

  const doors: TracedDoor[] = [];
  for (const door of raw.doors ?? []) {
    if (!isPoint(door.hinge) || !isPoint(door.latch)) continue;
    const hinge = toPx(door.hinge);
    const latch = toPx(door.latch);
    const swingTo = isPoint(door.swing_to) ? toPx(door.swing_to) : hinge;
    const horizontal = Math.abs(latch.x - hinge.x) >= Math.abs(latch.y - hinge.y);
    if (horizontal) latch.y = hinge.y;
    else latch.x = hinge.x;
    const length = Math.hypot(latch.x - hinge.x, latch.y - hinge.y);
    if (length < 3) continue;
    let normalX = -(latch.y - hinge.y) / length;
    let normalY = (latch.x - hinge.x) / length;
    if (normalX * (swingTo.x - hinge.x) + normalY * (swingTo.y - hinge.y) < 0) {
      normalX = -normalX;
      normalY = -normalY;
    }
    doors.push({
      hingeX: hinge.x,
      hingeY: hinge.y,
      closedX: latch.x,
      closedY: latch.y,
      openX: hinge.x + normalX * length,
      openY: hinge.y + normalY * length,
      kind: door.kind === "sliding" ? "sliding" : "swing",
    });
  }

  const windows: TracedWindow[] = (raw.windows ?? [])
    .filter((window) => isPoint(window.start) && isPoint(window.end))
    .map((window) => {
      const a = toPx(window.start);
      const b = toPx(window.end);
      const line = straighten({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, thickness: 0 });
      return { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 };
    });

  const openings = [
    ...doors.map((door) => ({ x1: door.hingeX, y1: door.hingeY, x2: door.closedX, y2: door.closedY })),
    ...windows,
  ];
  for (const opening of openings) walls = cutOpening(walls, opening);

  return { width, height, walls, doors, windows };
}

function clamp(value: number) {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function isPoint(point: unknown): point is Point {
  return (
    typeof point === "object" &&
    point !== null &&
    Number.isFinite((point as Point).x) &&
    Number.isFinite((point as Point).y)
  );
}

function straighten(segment: TracedSegment): TracedSegment {
  const dx = Math.abs(segment.x2 - segment.x1);
  const dy = Math.abs(segment.y2 - segment.y1);
  if (dy <= dx * 0.2) {
    const y = (segment.y1 + segment.y2) / 2;
    return { ...segment, y1: y, y2: y };
  }
  if (dx <= dy * 0.2) {
    const x = (segment.x1 + segment.x2) / 2;
    return { ...segment, x1: x, x2: x };
  }
  return segment;
}

function weldEndpoints(walls: TracedSegment[], reach: number): TracedSegment[] {
  const next = walls.map((wall) => ({ ...wall }));
  const ends = next.flatMap((wall, index) => [
    { index, end: 1 as const },
    { index, end: 2 as const },
  ]);
  const read = (item: (typeof ends)[number]) =>
    item.end === 1
      ? { x: next[item.index].x1, y: next[item.index].y1 }
      : { x: next[item.index].x2, y: next[item.index].y2 };
  const used = new Set<number>();
  for (let i = 0; i < ends.length; i += 1) {
    if (used.has(i)) continue;
    const group = [i];
    const origin = read(ends[i]);
    for (let j = i + 1; j < ends.length; j += 1) {
      if (used.has(j)) continue;
      const point = read(ends[j]);
      if (Math.hypot(point.x - origin.x, point.y - origin.y) <= reach) group.push(j);
    }
    if (group.length < 2) continue;
    const points = group.map((index) => read(ends[index]));
    const verticals = group.map((index) => next[ends[index].index]).filter((wall) => wall.x1 === wall.x2);
    const horizontals = group.map((index) => next[ends[index].index]).filter((wall) => wall.y1 === wall.y2);
    const x =
      verticals.length > 0
        ? verticals.reduce((sum, wall) => sum + wall.x1, 0) / verticals.length
        : points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const y =
      horizontals.length > 0
        ? horizontals.reduce((sum, wall) => sum + wall.y1, 0) / horizontals.length
        : points.reduce((sum, point) => sum + point.y, 0) / points.length;
    for (const index of group) {
      used.add(index);
      const wall = next[ends[index].index];
      const vertical = wall.x1 === wall.x2;
      const horizontal = wall.y1 === wall.y2;
      if (ends[index].end === 1) {
        if (!vertical) wall.x1 = x;
        if (!horizontal) wall.y1 = y;
      } else {
        if (!vertical) wall.x2 = x;
        if (!horizontal) wall.y2 = y;
      }
    }
  }
  return next;
}

function snapToWalls(walls: TracedSegment[], reach: number): TracedSegment[] {
  const next = walls.map((wall) => ({ ...wall }));
  for (const wall of next) {
    const horizontal = wall.y1 === wall.y2;
    const vertical = wall.x1 === wall.x2;
    if (!horizontal && !vertical) continue;
    for (const end of [1, 2] as const) {
      const x = end === 1 ? wall.x1 : wall.x2;
      const y = end === 1 ? wall.y1 : wall.y2;
      for (const other of next) {
        if (other === wall) continue;
        if (horizontal && other.x1 === other.x2) {
          const top = Math.min(other.y1, other.y2) - reach;
          const bottom = Math.max(other.y1, other.y2) + reach;
          if (Math.abs(other.x1 - x) > reach || y < top || y > bottom) continue;
          if (end === 1) wall.x1 = other.x1;
          else wall.x2 = other.x1;
          break;
        }
        if (vertical && other.y1 === other.y2) {
          const left = Math.min(other.x1, other.x2) - reach;
          const right = Math.max(other.x1, other.x2) + reach;
          if (Math.abs(other.y1 - y) > reach || x < left || x > right) continue;
          if (end === 1) wall.y1 = other.y1;
          else wall.y2 = other.y1;
          break;
        }
      }
    }
  }
  return next;
}

function cutOpening(
  walls: TracedSegment[],
  opening: { x1: number; y1: number; x2: number; y2: number },
): TracedSegment[] {
  const horizontal = Math.abs(opening.y2 - opening.y1) <= Math.abs(opening.x2 - opening.x1);
  const from = horizontal ? Math.min(opening.x1, opening.x2) : Math.min(opening.y1, opening.y2);
  const to = horizontal ? Math.max(opening.x1, opening.x2) : Math.max(opening.y1, opening.y2);
  const fixed = horizontal ? (opening.y1 + opening.y2) / 2 : (opening.x1 + opening.x2) / 2;
  return walls.flatMap((wall) => {
    const wallHorizontal = wall.y1 === wall.y2;
    const wallVertical = wall.x1 === wall.x2;
    if (horizontal ? !wallHorizontal : !wallVertical) return [wall];
    const wallFixed = horizontal ? wall.y1 : wall.x1;
    if (Math.abs(wallFixed - fixed) > wall.thickness + 3) return [wall];
    const start = horizontal ? Math.min(wall.x1, wall.x2) : Math.min(wall.y1, wall.y2);
    const end = horizontal ? Math.max(wall.x1, wall.x2) : Math.max(wall.y1, wall.y2);
    if (Math.min(end, to) - Math.max(start, from) <= 1) return [wall];
    const parts: TracedSegment[] = [];
    if (from - start > 1) {
      parts.push(
        horizontal
          ? { ...wall, x1: start, x2: from }
          : { ...wall, y1: start, y2: from },
      );
    }
    if (end - to > 1) {
      parts.push(
        horizontal
          ? { ...wall, x1: to, x2: end }
          : { ...wall, y1: to, y2: end },
      );
    }
    return parts;
  });
}
