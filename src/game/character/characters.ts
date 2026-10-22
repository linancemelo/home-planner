/** 6 個可愛角色（3 男 3 女），全部用基本幾何體組成（不用外部素材）。身高體重 → 眼高、身形比例。 */
export type HairStyle = "short" | "spiky" | "curly" | "twintails" | "bun" | "bob"
export type CharacterPreset = {
  id: string; name: string; gender: "male" | "female"; blurb: string
  skin: string; hair: string; top: string; bottom: string; shoes: string; accent: string
  hairStyle: HairStyle; skirt?: boolean; glasses?: boolean
  /** 預設身高 cm／體重 kg */
  height: number; weight: number
}

export const CHARACTERS: CharacterPreset[] = [
  { id: "m1", name: "小樂", gender: "male", blurb: "陽光短髮，愛跑跑跳跳", skin: "#f6d3b3", hair: "#3b2a20", top: "#6fb3e0", bottom: "#33506b", shoes: "#ffffff", accent: "#ffd166", hairStyle: "short", height: 172, weight: 65 },
  { id: "m2", name: "阿刺", gender: "male", blurb: "刺蝟頭，酷酷的", skin: "#eec39a", hair: "#e07a2e", top: "#7bc47f", bottom: "#4a4a58", shoes: "#2d2d2d", accent: "#ffffff", hairStyle: "spiky", height: 178, weight: 72 },
  { id: "m3", name: "捲捲", gender: "male", blurb: "捲毛眼鏡，喜歡看書", skin: "#d9a982", hair: "#2b2b2b", top: "#f2a65a", bottom: "#5b6f8a", shoes: "#8b5a3c", accent: "#333333", hairStyle: "curly", glasses: true, height: 168, weight: 60 },
  { id: "f1", name: "雙雙", gender: "female", blurb: "雙馬尾，活潑可愛", skin: "#fbd9c4", hair: "#5a3825", top: "#f7a6c1", bottom: "#ffffff", shoes: "#e85d8a", accent: "#ff6f91", hairStyle: "twintails", skirt: true, height: 158, weight: 48 },
  { id: "f2", name: "丸子", gender: "female", blurb: "雙丸子頭配蝴蝶結，溫柔體貼", skin: "#f3cfb0", hair: "#4a2c22", top: "#c9a7ef", bottom: "#b48be0", shoes: "#ff8fb1", accent: "#ff6f9f", hairStyle: "bun", skirt: true, height: 162, weight: 52 },
  { id: "f3", name: "小波", gender: "female", blurb: "鮑伯頭，俐落有型", skin: "#e8b995", hair: "#c9894a", top: "#ffe08a", bottom: "#4f8a8b", shoes: "#3d3d3d", accent: "#4f8a8b", hairStyle: "bob", skirt: true, height: 165, weight: 55 },
]

export const HEIGHT_RANGE = [100, 210] as const // cm
export const WEIGHT_RANGE = [20, 150] as const // kg

export type Body = { heightCm: number; weightKg: number }
export type PlayerSetup = { character: string; body: Body }
export const PLAYER_KEY = "home-planner.game.player.v1"

/** 身高體重 → 眼高（mm）、整體縮放（公尺高）、寬度係數（依 BMI，0.8–1.4）。 */
export function bodyMetrics(b: Body) {
  const h = Math.min(HEIGHT_RANGE[1], Math.max(HEIGHT_RANGE[0], b.heightCm))
  const w = Math.min(WEIGHT_RANGE[1], Math.max(WEIGHT_RANGE[0], b.weightKg))
  const bmi = w / (h / 100) ** 2
  return {
    heightM: h / 100,
    eyeMm: Math.round(h * 10 * 0.93),
    width: Math.min(1.4, Math.max(0.8, Math.sqrt(bmi / 21))),
    bmi: Math.round(bmi * 10) / 10,
  }
}

/** 嚴格解析身高體重輸入：只收一般十進位（最多一位小數），拒絕 1e2、0170、空白、+5 之類。不合法回傳 NaN。 */
export function parseBodyNum(s: string): number {
  return /^\s*(?:[1-9]\d{0,2})(?:\.\d)?\s*$/.test(s) ? Number(s) : NaN
}

export function validBody(b: Body): string | null {
  if (!Number.isFinite(b.heightCm) || b.heightCm < HEIGHT_RANGE[0] || b.heightCm > HEIGHT_RANGE[1]) return `身高請填 ${HEIGHT_RANGE[0]}–${HEIGHT_RANGE[1]} cm`
  if (!Number.isFinite(b.weightKg) || b.weightKg < WEIGHT_RANGE[0] || b.weightKg > WEIGHT_RANGE[1]) return `體重請填 ${WEIGHT_RANGE[0]}–${WEIGHT_RANGE[1]} kg`
  return null
}
