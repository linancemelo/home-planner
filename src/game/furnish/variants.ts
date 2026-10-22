/** 家具槽位與可替換款式（尺寸 mm；type 對應編輯器家具庫的繪製類型）。 */
export type Variant = { id: string; type: string; name: string; w: number; d: number; color: string }
export type SlotId =
  | "bed" | "nightstand" | "wardrobe" | "desk" | "deskchair" | "bookshelf"
  | "sofa" | "coffeetable" | "tvstand" | "tv" | "dining" | "diningchair" | "shoecab" | "rug"
  | "fridge" | "counter" | "stove" | "ksink"
  | "toilet" | "vanity" | "shower" | "washer"

export const VARIANTS: Record<SlotId, Variant[]> = {
  bed: [
    { id: "bed180", type: "bed", name: "雙人床 1.8m", w: 1800, d: 2000, color: "#c9d6df" },
    { id: "bed150", type: "bed", name: "雙人床 1.5m", w: 1500, d: 2000, color: "#d8c7dc" },
    { id: "bed120", type: "bed", name: "單人床", w: 1200, d: 2000, color: "#e8d5b5" },
  ],
  nightstand: [{ id: "ns45", type: "nightstand", name: "床頭櫃", w: 450, d: 400, color: "#e8dccb" }],
  wardrobe: [
    { id: "wd200", type: "wardrobe", name: "衣櫃 2m", w: 2000, d: 600, color: "#efe6d8" },
    { id: "wd120", type: "wardrobe", name: "小衣櫃", w: 1200, d: 550, color: "#efe6d8" },
    { id: "wd090", type: "wardrobe", name: "窄衣櫃 0.9m", w: 900, d: 550, color: "#efe6d8" },
    { id: "rack100", type: "wardrobe", name: "開放式吊衣架", w: 1000, d: 450, color: "#d9d2c5" },
  ],
  desk: [
    { id: "desk120", type: "desk", name: "書桌", w: 1200, d: 600, color: "#e2cfb4" },
    { id: "desk100", type: "desk", name: "小書桌", w: 1000, d: 500, color: "#e2cfb4" },
  ],
  deskchair: [{ id: "chair", type: "chair", name: "椅子", w: 450, d: 480, color: "#cfc6b8" }],
  bookshelf: [{ id: "shelf80", type: "bookshelf", name: "書架", w: 800, d: 300, color: "#e2cfb4" }],
  sofa: [
    { id: "sofa3", type: "sofa", name: "三人沙發", w: 2400, d: 900, color: "#b7c4b0" },
    { id: "sofa2", type: "sofa", name: "雙人沙發", w: 1700, d: 880, color: "#c3cbd6" },
    { id: "sofaL", type: "cornersofa", name: "L 型沙發", w: 2800, d: 1700, color: "#b7c4b0" },
    { id: "sofa1", type: "sofa", name: "小沙發", w: 1400, d: 800, color: "#d6c9b5" },
  ],
  coffeetable: [
    { id: "ct130", type: "coffeetable", name: "茶几", w: 1300, d: 650, color: "#e8dccb" },
    { id: "ct90", type: "sidetable", name: "小茶几", w: 900, d: 500, color: "#d9c3a3" },
  ],
  tvstand: [
    { id: "tv240", type: "tvstand", name: "電視櫃 2.4m", w: 2400, d: 400, color: "#e2cfb4" },
    { id: "tv150", type: "tvstand", name: "電視櫃 1.5m", w: 1500, d: 400, color: "#e2cfb4" },
  ],
  tv: [
    { id: "tv65", type: "tv", name: "65 吋電視", w: 1450, d: 80, color: "#1d1d1f" },
    { id: "tv55", type: "tv", name: "55 吋電視", w: 1230, d: 80, color: "#1d1d1f" },
  ],
  dining: [
    { id: "dt140", type: "table", name: "四人餐桌", w: 1400, d: 800, color: "#e2cfb4" },
    { id: "dt180", type: "table", name: "六人餐桌", w: 1800, d: 900, color: "#d8c2a2" },
    { id: "dtround", type: "roundtable", name: "圓桌", w: 1000, d: 1000, color: "#e2cfb4" },
  ],
  diningchair: [{ id: "dchair", type: "chair", name: "餐椅", w: 450, d: 480, color: "#cfc6b8" }],
  shoecab: [
    { id: "shoe100", type: "shoecab", name: "鞋櫃", w: 1000, d: 350, color: "#efe6d8" },
    { id: "shoe140", type: "shoecab", name: "玄關櫃", w: 1400, d: 380, color: "#e6dccc" },
  ],
  rug: [{ id: "rug", type: "rug", name: "地毯", w: 2400, d: 1700, color: "#d9cbb8" }],
  fridge: [
    { id: "fr70", type: "fridge", name: "冰箱", w: 700, d: 700, color: "#dfe4e8" },
    { id: "fr91", type: "fridge", name: "對開門冰箱", w: 910, d: 700, color: "#c9ced3" },
  ],
  counter: [
    { id: "ct160", type: "counter", name: "流理台", w: 1600, d: 600, color: "#e9e5de" },
    { id: "ct120", type: "counter", name: "短流理台", w: 1200, d: 600, color: "#e9e5de" },
  ],
  stove: [{ id: "stove", type: "stove", name: "瓦斯爐", w: 750, d: 600, color: "#dcdcdc" }],
  ksink: [{ id: "ksink", type: "ksink", name: "水槽", w: 800, d: 600, color: "#e1e6ea" }],
  toilet: [{ id: "toilet", type: "toilet", name: "馬桶", w: 400, d: 700, color: "#ffffff" }],
  vanity: [
    { id: "van80", type: "vanity", name: "浴室櫃", w: 800, d: 500, color: "#eef1f3" },
    { id: "van60", type: "vanity", name: "小浴室櫃", w: 600, d: 450, color: "#eef1f3" },
  ],
  shower: [
    { id: "shower90", type: "shower", name: "淋浴間", w: 900, d: 900, color: "#e4edf2" },
    { id: "tub", type: "bathtub", name: "浴缸", w: 1600, d: 750, color: "#eef3f6" },
  ],
  washer: [{ id: "washer", type: "washer", name: "洗衣機", w: 600, d: 600, color: "#e6ebee" }],
}

/** 會開關的家具（M4 用）。 */
export const OPENABLE_TYPES = new Set(["fridge"])
