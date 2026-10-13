"use client";

import { useState } from "react";
import { PlanSketch } from "@/components/PlanSketch";
import { UploadPanel } from "@/components/UploadPanel";
import type { ClaudeWallPlan } from "@/lib/claude-plan";
import type { CompressedImage } from "@/lib/compress-image";
import type { TracedPlan } from "@/lib/trace-floor-plan";

const SIDE_NAV = [
  "展示",
  "導覽",
  "漫遊",
  "對比",
  "生活",
  "動線",
  "收納",
  "家事",
  "回憶",
  "設計",
  "佈置",
  "格局",
  "風格",
  "日照",
  "量測",
] as const;

type Recognized = { plan: TracedPlan; raw: ClaudeWallPlan; model: string };

export function FloorPlanTab() {
  const [image, setImage] = useState<CompressedImage | null>(null);
  const [recognized, setRecognized] = useState<Recognized | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleImage(next: CompressedImage) {
    setImage(next);
    setRecognized(null);
    setError(null);
  }

  async function handleAnalyze() {
    if (!image?.contentWidth || !image.contentHeight) return;
    setAnalyzing(true);
    setError(null);
    try {
      const response = await fetch("/api/floor-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image: image.dataUrl,
          contentWidth: image.contentWidth,
          contentHeight: image.contentHeight,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as Partial<Recognized> & {
        error?: string;
      };
      if (!response.ok || !body.plan || !body.raw) {
        throw new Error(body.error || "辨識失敗");
      }
      setRecognized({ plan: body.plan, raw: body.raw, model: body.model ?? "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "辨識失敗");
    } finally {
      setAnalyzing(false);
    }
  }

  const shown = recognized?.plan ?? image?.trace;
  const wallCount = shown?.walls.length ?? 0;

  return (
    <div className="flex h-[calc(100dvh-4.75rem)] min-h-[36rem] gap-2">
      <nav
        aria-label="功能"
        className="flex w-[4.6rem] shrink-0 flex-col gap-0.5 overflow-y-auto rounded-xl border bg-card py-2"
      >
        {SIDE_NAV.map((item) => {
          const active = item === "漫遊";
          return (
            <button
              key={item}
              type="button"
              disabled={!active}
              aria-current={active ? "page" : undefined}
              title={active ? item : `${item}即將推出`}
              className={`mx-1 rounded-lg px-1 py-1.5 text-xs ${
                active
                  ? "bg-foreground font-medium text-background"
                  : "text-muted-foreground"
              }`}
            >
              {item}
            </button>
          );
        })}
      </nav>

      <section className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">平面圖對齊</h1>
            <p className="text-sm text-muted-foreground">
              {recognized
                ? "中間是 Claude 辨識出的牆、門、窗。傢俱先不辨識。"
                : "上傳後先依黑牆線粗描。按開始辨識，改用 Claude 只辨識牆、門、窗。"}
            </p>
            {shown ? (
              <p className="text-xs text-muted-foreground">
                {recognized ? `Claude（${recognized.model}）` : "黑線粗描"}：牆 {wallCount} 段、門{" "}
                {shown.doors.length}、窗 {shown.windows.length}
              </p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
          <UploadPanel
            previewUrl={image?.contentUrl ?? image?.dataUrl ?? null}
            analyzing={analyzing}
            onImage={handleImage}
            onAnalyze={handleAnalyze}
          />
        </div>

        <div className="min-h-0 flex-1 overflow-hidden rounded-xl border bg-[#f7f4ee]">
          {shown && wallCount > 0 ? (
            <PlanSketch trace={shown} />
          ) : (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {analyzing
                ? "Claude 辨識中，通常要半分鐘以上。"
                : image
                  ? "這張圖沒有描到足夠的牆線，可以按開始辨識。"
                  : "上傳平面圖後，中間會顯示描出的牆、門、窗。"}
            </div>
          )}
        </div>
      </section>

      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto rounded-xl border bg-card p-4">
        <p className="text-[11px] tracking-wide text-muted-foreground">對照原圖</p>
        <h2 className="text-lg font-semibold">裁切後的設計圖</h2>
        <p className="text-sm leading-6 text-muted-foreground">
          中間是描出來的牆、門弧和窗。這邊是同一張裁切後的圖，用來對位置。
        </p>
        {image?.contentUrl ? (
          <img
            src={image.contentUrl}
            alt="裁切後的平面設計圖"
            className="w-full rounded-lg border bg-[#f7f4ee] object-contain"
          />
        ) : (
          <div className="flex h-48 items-center justify-center rounded-lg border text-sm text-muted-foreground">
            尚未上傳
          </div>
        )}
        {recognized ? (
          <details className="rounded-lg border p-2 text-xs">
            <summary className="cursor-pointer font-medium">Claude 回傳的 JSON</summary>
            <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-4">
              {JSON.stringify(recognized.raw, null, 2)}
            </pre>
          </details>
        ) : null}
      </aside>
    </div>
  );
}
