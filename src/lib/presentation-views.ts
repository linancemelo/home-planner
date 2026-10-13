/**
 * 出圖視角。格局一律跟平面圖走，不另畫一套房間。
 * 漫遊仍用第一人稱和鳥瞰；這三個是效果圖視角。
 */
export const PRESENTATION_VIEWS = [
  {
    id: "colored-plan",
    name: "上色平面",
    camera: "俯視的室內平面渲染",
    framing: "中性地面環繞建築，用來襯出格局",
  },
  {
    id: "axonometric",
    name: "立軸圖",
    camera: "略微抬高的等距視角，約 30 到 45 度，開放式轉角，不要強烈透視",
    framing: "模型放在乾淨的中性底座上，背景淺色，不要外景",
  },
  {
    id: "section",
    name: "立面剖面",
    camera: "嚴格正投影，沒有透視。正面剖開客廳、廚房和相鄰房間",
    framing: "淺色中性背景。要看出牆、樓板、天花板的厚度，以及層高",
  },
] as const;

export type PresentationViewId = (typeof PRESENTATION_VIEWS)[number]["id"];

/** 三個出圖視角共用。傢俱、門窗跟平面圖同一套位置。 */
export const PRESENTATION_STYLE = {
  keep: "保留平面圖的佈局、比例、牆厚、開口和空間關係",
  light: "柔和自然光從一側進來，陰影輕，不要強烈明暗對比",
  mood: "簡潔、平靜，少量色彩。是建築室內圖，不是寫實透視大片",
} as const;
