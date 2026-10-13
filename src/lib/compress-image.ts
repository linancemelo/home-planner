import type { TracedPlan } from "@/lib/trace-floor-plan";

export interface CompressedImage {
  dataUrl: string;
  width: number;
  height: number;
  /** 0–100 格線對應的平面圖內容寬高，不含左側與上方的數字標籤 */
  contentWidth?: number;
  contentHeight?: number;
  /** 圖上已畫 0–100 座標格，模型應回報格線座標 */
  grid?: boolean;
  /** 裁切後、尚未加格線的平面圖，用來對照 */
  contentUrl?: string;
  /** 依黑牆線描出的平面圖 */
  trace?: TracedPlan;
}

/** 把圖片壓到指定最大寬度，回傳 JPEG data URL，減少之後送進模型的大小。 */
export function compressImage(
  file: File,
  maxWidth = 1280,
): Promise<CompressedImage> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      const scale = Math.min(1, maxWidth / image.width);
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");

      if (!context) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("無法壓縮圖片"));
        return;
      }

      context.drawImage(image, 0, 0, width, height);
      URL.revokeObjectURL(objectUrl);
      resolve({
        dataUrl: canvas.toDataURL("image/jpeg", 0.85),
        width,
        height,
      });
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("無法讀取圖片"));
    };

    image.src = objectUrl;
  });
}
