import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import { buildSummaryText } from "@/lib/calculations";
import type {
  DiagnosisResult,
  DiagnosisSection,
  DiagnosisSectionType,
  PlannerInputWan,
  PlannerResult,
} from "@/lib/types";

export const runtime = "nodejs";

interface DiagnoseBody {
  input: PlannerInputWan;
  result: PlannerResult;
}

const SECTION_META: Record<
  DiagnosisSectionType,
  { title: string; fallback: string }
> = {
  advantages: { title: "目前規劃的優點", fallback: "目前條件具備可執行性。" },
  risks: { title: "需要留意的風險", fallback: "仍需保留應急彈性。" },
  suggestions: { title: "可以優化的方向", fallback: "建議定期檢視規劃。" },
};

function parseDiagnosis(content: string): DiagnosisResult {
  const jsonStart = content.indexOf("{");
  const jsonEnd = content.lastIndexOf("}");
  const parsed = JSON.parse(
    jsonStart >= 0 && jsonEnd > jsonStart
      ? content.slice(jsonStart, jsonEnd + 1)
      : content
  ) as {
    overview?: unknown;
    sections?: unknown;
    disclaimer?: unknown;
  };

  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections = (
    Object.keys(SECTION_META) as DiagnosisSectionType[]
  ).map<DiagnosisSection>((type) => {
    const raw = rawSections.find(
      (section): section is { type?: unknown; title?: unknown; items?: unknown } =>
        typeof section === "object" &&
        section !== null &&
        "type" in section &&
        section.type === type
    );
    const items = Array.isArray(raw?.items)
      ? raw.items
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean)
          .slice(0, 5)
      : [];

    return {
      type,
      title:
        typeof raw?.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : SECTION_META[type].title,
      items: items.length ? items : [SECTION_META[type].fallback],
    };
  });

  return {
    overview:
      typeof parsed.overview === "string" && parsed.overview.trim()
        ? parsed.overview.trim()
        : "以下依目前輸入條件整理購屋規劃重點。",
    sections,
    disclaimer:
      typeof parsed.disclaimer === "string" &&
      parsed.disclaimer.trim().length >= 12
        ? parsed.disclaimer.trim()
        : "以上為一般性試算參考，不構成正式財務、投資或貸款建議。",
  };
}

export async function POST(request: Request) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey || apiKey === "your_groq_api_key_here") {
    return NextResponse.json(
      {
        error:
          "尚未設定有效的 GROQ_API_KEY。請在 .env.local 填入你的 Groq API Key。",
      },
      { status: 500 }
    );
  }

  let body: DiagnoseBody;
  try {
    body = (await request.json()) as DiagnoseBody;
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  if (!body?.input || !body?.result) {
    return NextResponse.json({ error: "缺少規劃資料" }, { status: 400 });
  }

  const summary = buildSummaryText(body.input, body.result);
  const model = process.env.GROQ_MODEL || "openai/gpt-oss-20b";

  try {
    const groq = new Groq({ apiKey });

    const completion = await groq.chat.completions.create({
      model,
      temperature: 0.6,
      max_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `你是一位友善、專業的台灣購屋前資產規劃顧問。請用繁體中文回覆。
語氣：溫暖、務實、不說教、不恐嚇。
分析時必須涵蓋自備款進度、房貸利率、貸款年限、寬限期（若有，需分開看寬限期月付與之後月付）、每月還款、總利息，以及預售分期節奏（若有）。
只輸出合法 JSON，不可使用 Markdown、程式碼圍欄或額外文字。格式必須為：
{
  "overview": "一至兩句整體評估",
  "sections": [
    {"type": "advantages", "title": "目前規劃的優點", "items": ["重點一", "重點二"]},
    {"type": "risks", "title": "需要留意的風險", "items": ["重點一", "重點二"]},
    {"type": "suggestions", "title": "可以優化的方向", "items": ["重點一", "重點二"]}
  ],
  "disclaimer": "一般性參考聲明"
}
每區 2 至 4 點，每點簡短具體；不要在字串內放 **、#、- 等 Markdown 符號。不要假裝能預測房價或利率。`,
        },
        {
          role: "user",
          content: `請診斷以下買房前資產規劃：\n\n${summary}`,
        },
      ],
    });

    const content =
      completion.choices[0]?.message?.content?.trim() ||
      '{"overview":"目前沒有取得診斷內容，請稍後再試。","sections":[]}';
    const diagnosis = parseDiagnosis(content);

    return NextResponse.json({ diagnosis });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "呼叫 Groq API 時發生錯誤";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
