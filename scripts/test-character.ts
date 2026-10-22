/** 角色與身高體重：6 個角色（3 男 3 女、id 唯一、預設身材合法）、嚴格數字輸入、範圍邊界、眼高與身寬換算、模型可建立。 */
import { bodyMetrics, CHARACTERS, HEIGHT_RANGE, parseBodyNum, validBody, WEIGHT_RANGE } from "../src/game/character/characters.ts"
import { buildAvatar } from "../src/game/character/avatar.ts"
let fail = 0
const ok = (c: boolean, m: string) => { if (!c) { fail++; console.log("FAIL", m) } }
ok(CHARACTERS.length === 6, "要 6 個角色")
ok(CHARACTERS.filter((c) => c.gender === "male").length === 3 && CHARACTERS.filter((c) => c.gender === "female").length === 3, "3 男 3 女")
ok(new Set(CHARACTERS.map((c) => c.id)).size === 6 && new Set(CHARACTERS.map((c) => c.hairStyle)).size === 6, "id、髮型都不重複")
for (const c of CHARACTERS) {
  ok(validBody({ heightCm: c.height, weightKg: c.weight }) === null, `${c.name} 預設身材不合法`)
  const a = buildAvatar(c)
  ok(a.group.children.length > 5, `${c.name} 模型建不起來`)
  a.animate(0.3, 1)
}
// 女生角色要有裙子或雙馬尾等明顯特徵（丸子不能和小樂撞輪廓）
ok(CHARACTERS.filter((c) => c.gender === "female").every((c) => c.skirt || c.hairStyle === "twintails"), "女生角色要有裙子或雙馬尾")
// 嚴格輸入
for (const [s, v] of [["170", 170], ["170.5", 170.5], [" 100 ", 100], ["210", 210]] as const) ok(parseBodyNum(s) === v, `「${s}」應解析為 ${v}`)
for (const s of ["", "abc", "1e2", "0170", "+170", "-5", "170.55", "17O", "Infinity", "0x64", "1,70"]) ok(Number.isNaN(parseBodyNum(s)), `「${s}」應被拒絕`)
// 範圍邊界
const H = HEIGHT_RANGE, W = WEIGHT_RANGE
ok(validBody({ heightCm: H[0], weightKg: 60 }) === null && validBody({ heightCm: H[1], weightKg: 60 }) === null, "身高邊界要可以")
ok(validBody({ heightCm: H[0] - 0.1, weightKg: 60 }) !== null && validBody({ heightCm: H[1] + 0.1, weightKg: 60 }) !== null, "身高超出要擋")
ok(validBody({ heightCm: 170, weightKg: W[0] }) === null && validBody({ heightCm: 170, weightKg: W[1] }) === null, "體重邊界要可以")
ok(validBody({ heightCm: 170, weightKg: W[0] - 0.1 }) !== null && validBody({ heightCm: 170, weightKg: NaN }) !== null, "體重超出／NaN 要擋")
// 換算
const m = bodyMetrics({ heightCm: 170, weightKg: 60.7 })
ok(m.eyeMm === 1581 && Math.abs(m.heightM - 1.7) < 1e-9, `眼高 0.93×身高（得 ${m.eyeMm}）`)
ok(Math.abs(m.width - 1) < 0.01, `BMI 21 時身寬約 1（得 ${m.width}）`)
ok(bodyMetrics({ heightCm: 170, weightKg: 40 }).width < 0.85 && bodyMetrics({ heightCm: 170, weightKg: 150 }).width === 1.4, "瘦／胖的身寬與上限")
console.log(fail ? `${fail} character checks failed` : "All character checks passed.")
if (fail) process.exit(1)
