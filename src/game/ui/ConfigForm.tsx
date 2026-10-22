import type { LayoutConfig } from "../layout/types.ts"

type Props = { value: LayoutConfig; range: [number, number] | null; onChange: (v: LayoutConfig) => void }

function Seg<T extends string | number>({ label, options, value, onPick }: { label: string; options: [T, string][]; value: T; onPick: (v: T) => void }) {
  return (
    <div className="gm-field">
      <span className="gm-label">{label}</span>
      <div className="gm-seg">
        {options.map(([v, t]) => (
          <button key={String(v)} type="button" className={v === value ? "on" : ""} onClick={() => onPick(v)}>{t}</button>
        ))}
      </div>
    </div>
  )
}

/** 系統配置表單：房數、坪數、廳、衛、廚房。坪數範圍依完整組合計算。 */
export function ConfigForm({ value: v, range, onChange }: Props) {
  // 改組合時清掉坪數，改用該組合的預設值，避免落在不可行範圍
  const set = (p: Partial<LayoutConfig>) => onChange({ ...v, ...p })
  const setCombo = (p: Partial<LayoutConfig>) => onChange({ ...v, ...p, ping: undefined })
  const [lo, hi] = range ?? [0, 0]
  const ping = v.ping
  return (
    <div className="gm-form">
      <Seg label="房間數" options={[[1, "1 房"], [2, "2 房"], [3, "3 房"], [4, "4 房"]]} value={v.bedrooms} onPick={(b) => setCombo({ bedrooms: b as LayoutConfig["bedrooms"] })} />
      <Seg label="幾廳" options={[[1, "1 廳"], [2, "2 廳（客廳＋餐廳分區）"]]} value={v.livings} onPick={(l) => setCombo({ livings: l as 1 | 2 })} />
      <Seg label="幾衛" options={[[1, "1 衛"], [2, "2 衛"], [3, "3 衛"]]} value={v.baths} onPick={(b) => setCombo({ baths: b as 1 | 2 | 3 })} />
      <Seg label="廚房" options={[["open", "開放式"], ["closed", "獨立式＋工作陽台"]]} value={v.kitchen} onPick={(k) => setCombo({ kitchen: k as LayoutConfig["kitchen"] })} />
      <div className="gm-field">
        <span className="gm-label">室內坪數 <b>{ping ?? "—"}</b> 坪</span>
        {range && <input type="range" min={lo} max={hi} step={1} value={ping ?? lo} onChange={(e) => set({ ping: +e.target.value })} />}
        <small>各房間淨面積合計、不含陽台。這個組合可做 {lo}–{hi} 坪</small>
      </div>
    </div>
  )
}
