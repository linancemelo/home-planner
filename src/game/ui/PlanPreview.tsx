import type { GeneratedLayout, RoomKind } from "../layout/types.ts"
import { boxOf, type GameFurniture } from "../furnish/autoFurnish.ts"

const FILL: Record<RoomKind, string> = {
  living: "#f6e7d3", bedroom: "#e9d9c1", bath: "#dbe6e8", kitchen: "#efe1cf", balcony: "#e2ead8", storage: "#e6e0d6", study: "#e3dccd", hall: "#f1e2cc",
}

/** 系統配置戶型 2D 預覽（SVG，mm 座標）；可畫家具並點選替換。 */
export function PlanPreview({ layout, items = [], selected, onPick }: { layout: GeneratedLayout; items?: GameFurniture[]; selected?: string | null; onPick?: (it: GameFurniture | null) => void }) {
  const bp = layout.blueprint
  const { x, y, w, h } = bp.bounds
  const [sx, sy] = layout.spawn.at
  return (
    <svg className="gm-preview" onClick={() => onPick?.(null)} viewBox={`${x} ${y} ${w} ${h}`} role="img" aria-label="戶型預覽">
      {bp.planRooms.map((r) => (
        <polygon key={r.id} points={r.poly.map((p) => p.join(",")).join(" ")} fill={FILL[layout.kinds[r.id]] ?? "#eee"} />
      ))}
      {bp.walls.map((wr, i) => (
        <rect key={i} x={wr[0]} y={wr[1]} width={wr[2] - wr[0]} height={wr[3] - wr[1]} fill={wr[4] === "low" ? "#a89c88" : "#4a3f35"} />
      ))}
      {bp.windowOpenings.map((o, i) => (
        <rect key={i} x={o[0]} y={o[1]} width={o[2] - o[0]} height={o[3] - o[1]} fill="#cfe6f2" stroke="#5a86a6" strokeWidth={20} />
      ))}
      {bp.slidingDoors.map((s, i) => (
        <g key={i}>
          <rect x={s.rect[0]} y={s.rect[1]} width={s.rect[2] - s.rect[0]} height={s.rect[3] - s.rect[1]} fill="#bfe0f0" stroke="#3f7aa0" strokeWidth={25} />
        </g>
      ))}
      {bp.swingDoors.map((d, i) => {
        const L = d.len, [hx, hy] = d.h
        const ox = hx + d.o[0] * L, oy = hy + d.o[1] * L, cx = hx + d.c[0] * L, cy = hy + d.c[1] * L
        const sweep = d.o[0] * d.c[1] - d.o[1] * d.c[0] > 0 ? 1 : 0
        const col = d.entry ? "#c0612f" : "#6b5a4a"
        return (
          <g key={i}>
            <rect x={d.rect[0]} y={d.rect[1]} width={d.rect[2] - d.rect[0]} height={d.rect[3] - d.rect[1]} fill="#fffaf2" />
            <line x1={hx} y1={hy} x2={ox} y2={oy} stroke={col} strokeWidth={d.entry ? 60 : 35} />
            <path d={`M${ox} ${oy}A${L} ${L} 0 0 ${sweep} ${cx} ${cy}`} fill="none" stroke={col} strokeWidth={18} strokeDasharray="60 40" />
          </g>
        )
      })}
      {bp.planRooms.map((r) => r.at && (
        <text key={r.id} x={r.at[0]} y={r.at[1]} fontSize={layout.kinds[r.id] === "bath" ? 260 : 340} textAnchor="middle" dominantBaseline="central" fill="#5a4636">{r.name}</text>
      ))}
      {layout.livingAreas.map((a, i) => (
        <g key={a.name}>
          {i > 0 && <line x1={a.rect[0]} y1={a.rect[1]} x2={a.rect[0]} y2={a.rect[3]} stroke="#c0612f" strokeWidth={30} strokeDasharray="120 90" />}
          <text x={(a.rect[0] + a.rect[2]) / 2} y={a.rect[3] - 350} fontSize={260} textAnchor="middle" fill="#c0612f">{a.name}</text>
        </g>
      ))}
      {items.filter((it) => it.type !== "tv").map((it) => {
        const b = boxOf(it.cx, it.cy, it.w, it.d, it.rot), sel = it.id === selected || (selected && it.slotKey === items.find((i) => i.id === selected)?.slotKey)
        const n = it.rot === 0 ? [0, 1] : it.rot === 90 ? [-1, 0] : it.rot === 180 ? [0, -1] : [1, 0]
        return (
          <g key={it.id} className="gm-furn" onClick={(e) => { e.stopPropagation(); onPick?.(it) }}>
            <title>{it.name}</title>
            <rect x={b[0]} y={b[1]} width={b[2] - b[0]} height={b[3] - b[1]} rx={40} fill={it.color} fillOpacity={it.type === "rug" ? 0.45 : 0.95} stroke={sel ? "#e0572a" : "#7a6a58"} strokeWidth={sel ? 70 : 18} />
            {it.type !== "rug" && <line x1={it.cx + n[0] * it.d * 0.15} y1={it.cy + n[1] * it.d * 0.15} x2={it.cx + n[0] * it.d * 0.45} y2={it.cy + n[1] * it.d * 0.45} stroke="#7a6a58" strokeWidth={22} />}
          </g>
        )
      })}
      <circle cx={sx} cy={sy} r={220} fill="#c0612f" />
      <text x={sx} y={sy - 380} fontSize={300} textAnchor="middle" fill="#c0612f" fontWeight={700}>起點</text>
    </svg>
  )
}
