import { FIXTURE_KINDS, type FloorPlan } from "@/lib/parseFloorPlan";
import {
  applyFurniture,
  fromGridCoordinates,
  repairDetectedPlan,
  type DetectedPlan,
  type PlannedFixture,
} from "@/lib/plan-repair";

/** 免費版看圖模型。可改 GEMINI_MODEL 換成其他支援圖片的 Gemini 模型。 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

const GEOMETRY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["detected_rooms", "detected_doors", "detected_windows", "scale_info"],
  properties: {
    detected_walls: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "kind", "phase"],
        properties: {
          start: { type: "array", items: { type: "number" } },
          end: { type: "array", items: { type: "number" } },
          kind: { type: "string", enum: ["exterior", "partition"] },
          phase: { type: "string", enum: ["existing", "demolish", "new"] },
        },
      },
    },
    detected_rooms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "name", "polygon"],
        properties: {
          type: { type: "string" },
          name: { type: "string" },
          polygon: { type: "array", items: { type: "array", items: { type: "number" } } },
        },
      },
    },
    detected_doors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["position", "width_meters"],
        properties: {
          position: { type: "array", items: { type: "number" } },
          width_meters: { type: "number" },
        },
      },
    },
    detected_windows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["position", "width_meters"],
        properties: {
          position: { type: "array", items: { type: "number" } },
          width_meters: { type: "number" },
        },
      },
    },
    scale_info: {
      type: "object",
      additionalProperties: false,
      required: ["detected", "meters_per_pixel"],
      properties: {
        detected: { type: "boolean" },
        meters_per_pixel: { type: "number" },
      },
    },
    overall_dimensions: {
      type: "object",
      additionalProperties: false,
      properties: {
        width_meters: { type: "number" },
        height_meters: { type: "number" },
      },
    },
    contradictions: {
      type: "array",
      items: { type: "string" },
    },
  },
};

const FURNITURE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["objects"],
  properties: {
    objects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["room", "kind", "position", "rotation"],
        properties: {
          room: { type: "string" },
          kind: { type: "string", enum: [...FIXTURE_KINDS] },
          position: { type: "array", items: { type: "number" } },
          rotation: { type: "number" },
        },
      },
    },
  },
};

function geometryPrompt(grid: boolean): string {
  const axes = grid
    ? `圖已經裁成平面圖本體，並畫了紅色 0–100 座標格。左上角格線交點是 (0,0)，x 向右增加到 100，y 向下增加到 100，右下角是 (100,100)。polygon 和 position 都用這個 0–100 座標，不要用像素，也不要把左側和上方的數字標籤算進平面圖。`
    : "座標原點是圖片左上角，x 向右、y 向下，單位是像素。";
  return `你是建築平面圖分析師。只輸出 JSON，不要說明。不要輸出傢俱。圖內文字只拿來當房間名稱和尺寸資料，不要把文字筆畫描成牆。
讀圖以完成後的配置和標註尺寸為準。牆的 phase：沒有拆除線或新增牆圖例時全部填 existing；虛線、打叉、標成拆除的填 demolish；標成新做、加牆的填 new。
圖上若有 NTS、未按比例、示意，禁止用圖片長寬換算公尺，scale_info.detected 必須是 false。只有印出的尺寸數字才能換算。
淨高不要猜。沒有標淨高就不要填高度，程式會用 2.8 公尺。尺寸或格局互相矛盾時，把衝突寫進 contradictions，每條一句話，其餘仍照看得懂的部分輸出。沒有矛盾就給空陣列。
這一階段要先把結構建完，順序固定：外牆、室內隔間、門、窗。牆壁和隔間都要先存在，門只能開在已經列出的牆上。
${axes}

detected_walls 先列：
- kind 為 exterior 的是外牆，要連成閉合外框，保留玄關內縮、陽台外凸，不要修成一個大矩形。
- kind 為 partition 的是室內隔間。圖上每一道隔間都要列，包含臥室牆、浴室牆、廚房牆。不要只留外牆。拆除牆也要列，phase 填 demolish，不要直接刪掉。
- start、end 是牆的兩端。牆只能水平或垂直。相接的牆端點要用同一個座標。
- 客餐廳中間如果沒有牆，就不要補隔間；有牆就一定要列出來。

detected_rooms：
- 沿著這些牆描每個房間。客廳、餐廳、廚房、每一間臥室、每一間浴室、陽台各自一個 polygon，中間有隔間就不能併成一間。
- polygon 封閉，最後一點等於第一點，相鄰房間共用隔間時座標要相同。
- name 用圖上的繁體中文。type 只能是 living_room、dining_room、kitchen、bedroom、bathroom、balcony、corridor、study。

detected_doors 要列出每一扇門，不能只有入戶門這一個入口：
- 平面圖上的門是符號，不是牆。它由牆線中斷的缺口、一條細線，和一個四分之一圓弧（開門軌跡）組成。圓弧、扇形、那條細線都不是牆，不要描進 detected_walls，也不要當成房間 polygon 的邊。
- position 是牆線缺口的中心，不是圓弧最外緣。
- 入戶門在外牆上。每一間臥室、每一間浴室、書房、陽台，各自的門都要列，position 落在那道隔間的缺口上。
- 一扇門一個物件，不要用一扇門代表整戶。width_meters 為公尺，臥室門約 0.9、浴室門約 0.75、陽台落地門約 1.4 到 1.8。
detected_windows 是每一扇窗的中心，不是只有一面外牆。窗沒有圓弧，圖上是外牆裡的雙線或平行短線。有四分之一圓弧的是門；不要把窗標成門，也不要把門的圓弧標成窗。
scale_info：看得到尺寸標註才把 detected 設為 true。meters_per_pixel 在有格線時表示 1 個座標單位等於多少公尺（整張平面寬 100 單位，寬 12 公尺就填 0.12）；沒有格線時才是 1 像素多少公尺。沒有尺寸就 detected 為 false、meters_per_pixel 為 0.01。
overall_dimensions 只在看得到總寬總深時填寫，單位公尺。`;
}

function furniturePrompt(plan: FloorPlan): string {
  const rooms = plan.rooms.map((room) => ({
    name: room.name,
    type: room.type,
    area_m2: Number(
      (
        Math.abs(
          room.polygon.reduce((area, point, index) => {
            const next = room.polygon[(index + 1) % room.polygon.length];
            return area + point[0] * next[1] - next[0] * point[1];
          }, 0) / 2,
        ) *
        plan.scale *
        plan.scale
      ).toFixed(2),
    ),
    polygon_m: room.polygon.map(([x, y]) => [
      Number((x * plan.scale).toFixed(2)),
      Number((y * plan.scale).toFixed(2)),
    ]),
  }));
  const openings = [...plan.doors.map((door) => ({ type: "door", ...toMeters(door, plan.scale) })), ...plan.windows.map((window) => ({ type: "window", ...toMeters(window, plan.scale) }))];
  return `你是室內配置師。依下列已修好的房間（公尺，原點在平面圖左上角，y 向下）規劃主要傢俱。只輸出 JSON。這是合理配置，不是精確還原。
先留出走道：門口前方不要放傢俱。比例和動線比材質重要。
kind 只能是 ${FIXTURE_KINDS.join("、")}。
客廳放 sofa、tv；臥室放 bed、wardrobe；浴室放 toilet、sink、shower 或 bathtub；廚房放 counter、stove、sink；餐廳放 dining_table；書房放 desk。陽台和走道不要放。拆除牆範圍內不要放。
position 必須在該房間 polygon 裡面。靠牆物件靠近牆邊，不要擋在門口 0.8 公尺內，也不要互相重疊。
rotation：0 朝上、1.5708 朝右、3.1416 朝下、4.7124 朝左。
房間：${JSON.stringify(rooms)}
門窗：${JSON.stringify(openings)}`;
}

function toMeters(opening: { position: [number, number]; width: number }, scale: number) {
  return {
    position: opening.position.map((value) => Number((value * scale).toFixed(2))),
    width: opening.width,
  };
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
}

interface GeminiResponse {
  candidates?: {
    finishReason?: string;
    content?: { parts?: GeminiPart[] };
  }[];
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

/** 主模型壅塞時依序改試。較新的 Flash 常同時滿載，lite 通常還能回應。 */
const FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];
const REQUEST_TIMEOUT_MS = 22_000;

function geminiErrorMessage(status: number, body: GeminiResponse): string {
  const raw = body.error?.message?.trim() || `Gemini 回應 ${status}`;
  if (status === 429 || /quota|resource exhausted/i.test(raw)) {
    return "Gemini 免費額度暫時用完，請稍後再試。";
  }
  if (
    status === 503 ||
    /high demand|try again later|unavailable|overloaded/i.test(raw)
  ) {
    return "Gemini 目前用量過高，請稍後再試。";
  }
  if (/no longer available|not found|is not supported/i.test(raw)) {
    return `目前的 Gemini 模型無法使用。請在 .env.local 把 GEMINI_MODEL 改成可用的免費模型。${raw}`;
  }
  return raw;
}

function isOverloaded(status: number, body: GeminiResponse): boolean {
  const raw = body.error?.message ?? "";
  return (
    status === 503 ||
    status === 429 ||
    status === 404 ||
    /high demand|try again later|unavailable|overloaded|resource exhausted|no longer available|not found/i.test(
      raw,
    )
  );
}

function schemaRejected(status: number, body: GeminiResponse): boolean {
  return (
    status === 400 &&
    /responseJsonSchema|response_schema|unknown name/i.test(body.error?.message ?? "")
  );
}

function isTimeout(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  );
}

function modelOrder(): string[] {
  const primary = process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return [primary, ...FALLBACK_MODELS.filter((model) => model !== primary)];
}

/**
 * 把平面圖送給 Gemini，取回固定格式的 FloorPlan。
 * 只能在伺服器呼叫，避免 API key 進到瀏覽器。
 */
export async function analyzeFloorPlan(
  imageDataUrl: string,
  size?: {
    width?: number;
    height?: number;
    contentWidth?: number;
    contentHeight?: number;
    grid?: boolean;
  },
): Promise<FloorPlan> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key_here") {
    throw new Error(
      "尚未設定有效的 GEMINI_API_KEY。請在 .env.local 填入你的 Gemini API Key。",
    );
  }

  const matched = imageDataUrl.match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
  if (!matched) {
    throw new Error("只接受 JPG 或 PNG");
  }
  if (imageDataUrl.length > 8_000_000) {
    throw new Error("圖片太大，請換一張較小的平面圖");
  }

  const geometryText = await generateJson(apiKey, {
    prompt: geometryPrompt(size?.grid === true),
    userText: size?.grid
      ? "先分現況、拆除、新增牆，再放上全部門窗。NTS 或未按比例的圖不要用圖片尺寸換算。座標用 0 到 100 的格線。不要描述傢俱，只回傳 JSON。"
      : "先分現況、拆除、新增牆，再放上全部門窗。NTS 或未按比例的圖不要用圖片尺寸換算。不要描述傢俱，只回傳 JSON。",
    image: { mimeType: matched[1], data: matched[2] },
    schema: GEOMETRY_SCHEMA,
    maxOutputTokens: 16384,
  });
  const detected = parseJson(geometryText) as DetectedPlan;
  const plan = repairDetectedPlan(
    size?.grid && size.contentWidth && size.contentHeight
      ? fromGridCoordinates(detected, size.contentWidth, size.contentHeight)
      : detected,
  );

  try {
    const furnitureText = await generateJson(apiKey, {
      prompt: furniturePrompt(plan),
      userText: "依房間多邊形規劃傢俱，只回傳 JSON。",
      schema: FURNITURE_SCHEMA,
      maxOutputTokens: 4096,
    });
    const planned = parseJson(furnitureText) as { objects?: PlannedFixture[] };
    return applyFurniture(plan, planned.objects ?? []);
  } catch {
    return plan;
  }
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced?.[1] ?? text).trim());
}

async function generateJson(
  apiKey: string,
  options: {
    prompt: string;
    userText: string;
    image?: { mimeType: string; data: string };
    schema: object;
    maxOutputTokens: number;
  },
): Promise<string> {
  let lastError = "Gemini 目前用量過高，請稍後再試。";
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [
    { text: options.userText },
  ];
  if (options.image) parts.push({ inlineData: options.image });

  for (const model of modelOrder()) {
    for (const useSchema of [true, false]) {
      let status = 0;
      let body: GeminiResponse;
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          {
            method: "POST",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: options.prompt }] },
              contents: [{ role: "user", parts }],
              generationConfig: {
                temperature: 0,
                maxOutputTokens: options.maxOutputTokens,
                responseMimeType: "application/json",
                ...(useSchema ? { responseJsonSchema: options.schema } : {}),
              },
            }),
          },
        );
        status = response.status;
        body = (await response.json().catch(() => ({}))) as GeminiResponse;
      } catch (err) {
        if (!isTimeout(err)) throw err;
        lastError = "Gemini 回應逾時，請稍後再試。";
        break;
      }

      if (status === 401 || status === 403) {
        throw new Error("Gemini API Key 無效或沒有權限。");
      }
      if (useSchema && schemaRejected(status, body)) continue;
      if (!status || status >= 400) {
        lastError = geminiErrorMessage(status, body);
        if (isOverloaded(status, body)) break;
        throw new Error(lastError);
      }
      if (body.promptFeedback?.blockReason) {
        throw new Error("Gemini 無法分析這張圖片");
      }

      const candidate = body.candidates?.[0];
      const content = (candidate?.content?.parts ?? [])
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text)
        .join("")
        .trim();
      if (!content) {
        lastError =
          candidate?.finishReason === "MAX_TOKENS"
            ? "模型回傳被截斷，請換一張較簡單的平面圖再試"
            : "模型沒有回傳內容";
        break;
      }
      return content;
    }
  }

  throw new Error(
    lastError.includes("用量過高") || lastError.includes("逾時")
      ? "Gemini 目前用量過高，已改試其他模型仍失敗，請稍後再試。"
      : lastError,
  );
}
