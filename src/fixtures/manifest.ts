import type { Floorplan } from "../types/floorplan.ts"
import simpleUrl from "./simple-room.png"
import simpleExpected from "./simple-room.expected.json" with { type: "json" }
import twoUrl from "./two-room.png"
import twoExpected from "./two-room.expected.json" with { type: "json" }
import lUrl from "./l-shape.png"
import lExpected from "./l-shape.expected.json" with { type: "json" }
import clutterUrl from "./clutter.png"
import clutterExpected from "./clutter.expected.json" with { type: "json" }
import ambiguousUrl from "./ambiguous-swing.png"
import ambiguousExpected from "./ambiguous-swing.expected.json" with { type: "json" }
import marketingUrl from "./real-samples/marketing-591.jpg"
import furnishedUrl from "./real-samples/furnished-en.jpg"
import cadUrl from "./real-samples/interior-design-cad.jpg"

export type SamplePlan = {
  id: string
  title: string
  description: string
  imageUrl: string
  expected: Floorplan | null
}

export const samples: SamplePlan[] = [
  {
    id: "simple-room",
    title: "單房，平開門與窗",
    description: "矩形雙線牆。下方是帶門扇與四分之一圓弧的平開門，上方是窗。",
    imageUrl: simpleUrl,
    expected: simpleExpected as Floorplan,
  },
  {
    id: "two-room",
    title: "兩房，平開、拉門與窗",
    description: "隔間上有平開門，下方外牆是拉門，右側是窗。上方外牆畫成實心粗線。",
    imageUrl: twoUrl,
    expected: twoExpected as Floorplan,
  },
  {
    id: "l-shape",
    title: "L 形，含未辨識缺口",
    description: "上方平開門會被挖除。下方共線缺口沒有門窗特徵，仍合併成一道牆。",
    imageUrl: lUrl,
    expected: lExpected as Floorplan,
  },
  {
    id: "clutter",
    title: "有圖框、圖說與雜訊",
    description: "外框、圖說、指北針、比例尺、家具與夾了符號的假雙線都不該變成牆。",
    imageUrl: clutterUrl,
    expected: clutterExpected as Floorplan,
  },
  {
    id: "ambiguous-swing",
    title: "只有門扇、沒有圓弧",
    description: "缺口旁只有門扇線。缺少圓弧就不輸出門，並在備註註明特徵不足。",
    imageUrl: ambiguousUrl,
    expected: ambiguousExpected as Floorplan,
  },
  {
    id: "marketing-591",
    title: "銷售圖，實心黑牆",
    description: "有浮水印、家具與色帶。只留近黑的牆。門弧若沒有牆缺口就不猜。",
    imageUrl: marketingUrl,
    expected: null,
  },
  {
    id: "furnished-en",
    title: "彩色平面，英文房名",
    description: "粗牆與柱。玻璃隔間和灰色拉門扇可能被略過。",
    imageUrl: furnishedUrl,
    expected: null,
  },
  {
    id: "interior-design-cad",
    title: "施工圖，右側標題欄",
    description: "尺寸數字不採信。標題欄與指北針會遮掉。斜向凸窗這版跟不到。",
    imageUrl: cadUrl,
    expected: null,
  },
]
