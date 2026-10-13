import { NextResponse } from "next/server";
import { analyzeWallsWithClaude } from "@/lib/claude-plan";

export const runtime = "nodejs";
export const maxDuration = 90;

export async function POST(request: Request) {
  let body: {
    image?: unknown;
    contentWidth?: unknown;
    contentHeight?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "請求格式錯誤" }, { status: 400 });
  }

  if (typeof body.image !== "string" || !body.image.startsWith("data:image/")) {
    return NextResponse.json({ error: "缺少平面圖" }, { status: 400 });
  }
  const contentWidth = Number(body.contentWidth);
  const contentHeight = Number(body.contentHeight);
  if (!(contentWidth > 0) || !(contentHeight > 0)) {
    return NextResponse.json({ error: "缺少平面圖尺寸" }, { status: 400 });
  }

  try {
    const result = await analyzeWallsWithClaude(body.image, { contentWidth, contentHeight });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "辨識失敗";
    const status = message.includes("ANTHROPIC_API_KEY") ? 500 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
