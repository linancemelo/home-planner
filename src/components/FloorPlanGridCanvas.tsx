"use client";

import { useEffect, useRef } from "react";
import type { CompressedImage } from "@/lib/compress-image";
import { findFloorPlanBounds } from "@/lib/crop-floor-plan";
import { traceFloorPlan } from "@/lib/trace-floor-plan";

const MAX_CONTENT = 1280;
const GUTTER_X = 42;
const GUTTER_Y = 26;

type FloorPlanGridCanvasProps = {
  sourceUrl: string | null;
  onImage: (image: CompressedImage) => void;
  onError: (message: string) => void;
};

function drawGrid(
  context: CanvasRenderingContext2D,
  contentWidth: number,
  contentHeight: number,
) {
  context.font = "12px sans-serif";
  context.lineWidth = 1;
  for (let step = 0; step <= 10; step += 1) {
    const ratio = step / 10;
    const x = GUTTER_X + contentWidth * ratio;
    const y = GUTTER_Y + contentHeight * ratio;
    const major = step % 2 === 0;
    context.strokeStyle = major ? "rgba(159, 18, 57, 0.72)" : "rgba(159, 18, 57, 0.28)";
    context.beginPath();
    context.moveTo(x, GUTTER_Y);
    context.lineTo(x, GUTTER_Y + contentHeight);
    context.stroke();
    context.beginPath();
    context.moveTo(GUTTER_X, y);
    context.lineTo(GUTTER_X + contentWidth, y);
    context.stroke();
    if (!major) continue;
    context.fillStyle = "#9f1239";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(step * 10), x, GUTTER_Y / 2);
    context.textAlign = "right";
    context.fillText(String(step * 10), GUTTER_X - 4, y);
  }
}

/**
 * 不顯示在畫面上。把海報裁成平面圖本體，畫上 0–100 座標格，再把這張圖交給辨識。
 */
export function FloorPlanGridCanvas({
  sourceUrl,
  onImage,
  onError,
}: FloorPlanGridCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onImageRef = useRef(onImage);
  const onErrorRef = useRef(onError);
  onImageRef.current = onImage;
  onErrorRef.current = onError;

  useEffect(() => {
    if (!sourceUrl) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const sample = document.createElement("canvas");
      sample.width = image.width;
      sample.height = image.height;
      const sampleContext = sample.getContext("2d", { willReadFrequently: true });
      const output = canvasRef.current;
      const outputContext = output?.getContext("2d");
      if (!sampleContext || !output || !outputContext) {
        onErrorRef.current("無法處理圖片");
        return;
      }
      sampleContext.drawImage(image, 0, 0);
      const bounds = findFloorPlanBounds(
        sampleContext.getImageData(0, 0, image.width, image.height).data,
        image.width,
        image.height,
      );
      const scale = Math.min(1, MAX_CONTENT / bounds.width, MAX_CONTENT / bounds.height);
      const contentWidth = Math.max(1, Math.round(bounds.width * scale));
      const contentHeight = Math.max(1, Math.round(bounds.height * scale));
      output.width = contentWidth + GUTTER_X + 8;
      output.height = contentHeight + GUTTER_Y + 4;
      outputContext.fillStyle = "#f7f4ee";
      outputContext.fillRect(0, 0, output.width, output.height);
      outputContext.drawImage(
        image,
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        GUTTER_X,
        GUTTER_Y,
        contentWidth,
        contentHeight,
      );
      const content = outputContext.getImageData(GUTTER_X, GUTTER_Y, contentWidth, contentHeight);
      const trace = traceFloorPlan(content.data, contentWidth, contentHeight);
      const contentUrl = output.toDataURL("image/jpeg", 0.86);
      drawGrid(outputContext, contentWidth, contentHeight);
      onImageRef.current({
        dataUrl: output.toDataURL("image/jpeg", 0.86),
        width: output.width,
        height: output.height,
        contentWidth,
        contentHeight,
        grid: true,
        contentUrl,
        trace,
      });
    };
    image.onerror = () => {
      if (!cancelled) onErrorRef.current("無法讀取圖片");
    };
    image.src = sourceUrl;
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  return <canvas ref={canvasRef} hidden aria-hidden />;
}
