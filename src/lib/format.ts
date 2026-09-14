import { WAN_TO_YUAN } from "./defaults";

/** 元 → 萬元 */
export function yuanToWan(yuan: number): number {
  return yuan / WAN_TO_YUAN;
}

/**
 * 格式化萬元數字（千分位，避免 SSR/CSR locale 差異）
 */
export function formatWan(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "0";
  const negative = value < 0;
  const abs = Math.abs(value);
  const factor = 10 ** digits;
  const rounded = Math.round(abs * factor) / factor;
  const [intRaw, decRaw = ""] = rounded.toFixed(digits).split(".");
  const intPart = intRaw.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmedDec = decRaw.replace(/0+$/, "");
  const body = trimmedDec ? `${intPart}.${trimmedDec}` : intPart;
  return negative ? `-${body}` : body;
}

/** 元金額以萬元格式顯示 */
export function formatYuanAsWan(yuan: number, digits = 2): string {
  return formatWan(yuanToWan(yuan), digits);
}

/** 百分比顯示（ratio 為 0–1） */
export function formatPercent(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return "0%";
  return `${formatWan(ratio * 100, digits)}%`;
}

/** 年月顯示 YYYY/MM */
export function formatYearMonth(year: number, month: number): string {
  return `${year}/${String(month).padStart(2, "0")}`;
}
