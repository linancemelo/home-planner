"use client";

import { useEffect, useRef, useState } from "react";
import { ImageUp } from "lucide-react";
import { FloorPlanGridCanvas } from "@/components/FloorPlanGridCanvas";
import { Button } from "@/components/ui/button";
import type { CompressedImage } from "@/lib/compress-image";

type UploadPanelProps = {
  previewUrl: string | null;
  analyzing: boolean;
  onImage: (image: CompressedImage) => void;
  onAnalyze?: () => void;
};

export function UploadPanel({
  previewUrl,
  analyzing,
  onImage,
  onAnalyze,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (sourceUrl) URL.revokeObjectURL(sourceUrl);
    };
  }, [sourceUrl]);

  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setError("請上傳 JPG 或 PNG");
      return;
    }

    setBusy(true);
    setError(null);
    const nextUrl = URL.createObjectURL(file);
    setSourceUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return nextUrl;
    });
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt="平面圖預覽"
            className="h-9 w-16 rounded-md border object-cover"
          />
        ) : null}
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,.jpg,.jpeg,.png"
          className="sr-only"
          onChange={handleChange}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy || analyzing}
          onClick={() => inputRef.current?.click()}
        >
          <ImageUp />
          {busy ? "處理中" : "上傳平面圖"}
        </Button>
        {onAnalyze ? (
          <Button
            type="button"
            disabled={!previewUrl || busy || analyzing}
            onClick={onAnalyze}
          >
            {analyzing ? "辨識中" : "開始辨識"}
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <FloorPlanGridCanvas
        sourceUrl={sourceUrl}
        onImage={(image) => {
          setBusy(false);
          onImage(image);
        }}
        onError={(message) => {
          setBusy(false);
          setError(message);
        }}
      />
    </div>
  );
}
