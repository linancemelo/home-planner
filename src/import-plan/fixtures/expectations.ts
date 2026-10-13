/** 測試用：實際備註必須包含這些句子，且不該出現禁止句。 */

export type FixtureExpect = {
  id: string
  title: string
  noteIncludes: string[]
  forbidNotes: string[]
}

export const fixtureExpectations: FixtureExpect[] = [
  {
    id: "simple-room",
    title: "單房，平開門與窗",
    noteIncludes: ["未採信"],
    forbidNotes: ["疑似平開門但特徵不足", "可能有未辨識開口"],
  },
  {
    id: "two-room",
    title: "兩房，平開、拉門與窗",
    noteIncludes: ["未採信"],
    forbidNotes: ["疑似平開門但特徵不足", "可能有未辨識開口"],
  },
  {
    id: "l-shape",
    title: "L 形，含未辨識缺口",
    noteIncludes: ["未採信", "可能有未辨識開口"],
    forbidNotes: ["疑似平開門但特徵不足"],
  },
  {
    id: "clutter",
    title: "有圖框、圖說與雜訊",
    noteIncludes: ["未採信", "未視為牆"],
    forbidNotes: ["疑似平開門但特徵不足"],
  },
  {
    id: "ambiguous-swing",
    title: "只有門扇、沒有圓弧",
    noteIncludes: ["未採信", "疑似平開門但特徵不足", "可能有未辨識開口"],
    forbidNotes: [],
  },
]
