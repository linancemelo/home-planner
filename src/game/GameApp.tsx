import { useEffect, useMemo, useState } from "react"
import { AppShell } from "../studio/layout/AppShell"
import { BLUEPRINT_STORAGE_KEY } from "../plan/types/blueprint.ts"
import { SCHEME_STORAGE_KEY } from "../plan/state/schemeStore.ts"
import { createDefaultBlueprint } from "../plan/data/defaultApartment.ts"
import { feasibleRange, generateLayout, nextDistinctSeed } from "./layout/generateLayout.ts"
import { validateLayout } from "./layout/validateLayout.ts"
import { BudgetError, type GeneratedLayout, type LayoutConfig } from "./layout/types.ts"
import { autoFurnish, swapOptions, toScheme } from "./furnish/autoFurnish.ts"
import { validateFurniture } from "./furnish/validateFurniture.ts"
import { swapItem } from "./furnish/swap.ts"
import { ConfigForm } from "./ui/ConfigForm"
import { PlayScreen } from "./scene/PlayScreen"
import { BodyStep, CharacterStep, loadPlayer } from "./character/CharacterSelect"
import type { PlayerSetup } from "./character/characters.ts"
import { layoutFromBlueprint } from "./layout/fromBlueprint.ts"
import type { GameFurniture } from "./furnish/autoFurnish.ts"
import { PlanPreview } from "./ui/PlanPreview"
import "./game.css"

export const GAME_FURNISH_KEY = "home-planner.game.furnish.v1"

type Screen = "start" | "config" | "studio" | "walk"
const screenFromHash = (): Screen => {
  const h = location.hash.replace(/^#\/?/, "")
  return h === "config" || h === "studio" || h === "walk" ? h : "start"
}

/** 格局之後的流程：選角色 → 身高體重 → 漫遊。 */
export function WalkFlow({ layout, items, onExit }: { layout: GeneratedLayout; items: GameFurniture[]; onExit: () => void }) {
  const [step, setStep] = useState<"char" | "body" | "play">("char")
  const [player, setPlayer] = useState<PlayerSetup>(loadPlayer)
  if (step === "char") return <CharacterStep value={player} onBack={onExit} onNext={(p) => { setPlayer(p); setStep("body") }} />
  if (step === "body") return <BodyStep value={player} onBack={() => setStep("char")} onNext={(p) => { setPlayer(p); setStep("play") }} />
  return <PlayScreen layout={layout} items={items} player={player} onBack={() => setStep("body")} />
}

/** 從編輯器（自己建的格局）進入漫遊：同一套 PlayScreen／家具／碰撞；無家具時 autoFurnish。 */
function EditorWalk({ onExit }: { onExit: () => void }) {
  const res = useMemo(() => {
    try {
      const bp = JSON.parse(localStorage.getItem(BLUEPRINT_STORAGE_KEY) || "null") ?? createDefaultBlueprint()
      const sch = JSON.parse(localStorage.getItem(SCHEME_STORAGE_KEY) || "null")
      let furniture = sch?.furniture ?? []
      // 系統配置寫入的遊戲家具（含 slot）；編輯器 scheme 被清空時仍可用
      if (!furniture.length) {
        try {
          const gf = JSON.parse(localStorage.getItem(GAME_FURNISH_KEY) || "null")
          if (Array.isArray(gf?.items) && gf.items.length) furniture = gf.items
        } catch { /* ignore */ }
      }
      return layoutFromBlueprint(bp, furniture)
    } catch (e) { return { error: `讀不到編輯器的格局：${e}` } }
  }, [])
  if ("error" in res) return (
    <div className="gm-screen"><div className="gm-err gm-block">⚠️ {res.error}</div><button type="button" className="gm-btn ghost" onClick={onExit}>← 回編輯器</button></div>
  )
  return <WalkFlow layout={res.layout} items={res.items} onExit={onExit} />
}

/** 遊戲入口：開始畫面 → 自己建格局（原編輯器）／系統配置。 */
export function GameApp() {
  const [screen, setScreen] = useState<Screen>(screenFromHash)
  useEffect(() => {
    const on = () => {
      const next = screenFromHash()
      // 編輯器是命令式全域腳本：離開時整頁重載，確保乾淨卸載
      if (screen === "studio" && next !== "studio") { location.reload(); return }
      setScreen(next)
    }
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [screen])
  const go = (s: Screen) => { location.hash = s === "start" ? "/" : `/${s}` }

  if (screen === "studio") return (
    <>
      <AppShell />
      <button type="button" className="gm-back-float" onClick={() => go("start")}>← 回開始畫面</button>
      <button type="button" className="gm-back-float gm-walk-float" onClick={() => {
        // 先點編輯器「漫遊」觸發 save；若 anim／2D 讓 setMode no-op，再強制 go("walk")
        const b = document.querySelector('#modes3d [data-mode="walk"]') as HTMLButtonElement | null
        b?.click()
        if (!/#\/?walk\b/.test(location.hash)) go("walk")
      }}>進去走走 →</button>
    </>
  )
  if (screen === "walk") return <EditorWalk onExit={() => go("studio")} />
  if (screen === "config") return <ConfigScreen onBack={() => go("start")} onOpenEditor={() => go("studio")} />
  return <StartScreen onPick={go} />
}

function StartScreen({ onPick }: { onPick: (s: Screen) => void }) {
  return (
    <div className="gm-screen gm-start">
      <h1>我的小窩 <span>3D</span></h1>
      <p className="gm-sub">先決定房子怎麼來，再選角色走進去逛逛</p>
      <div className="gm-cards">
        <button type="button" className="gm-card" onClick={() => onPick("studio")}>
          <span className="gm-ic">✏️</span>
          <b>自己建房子格局</b>
          <small>用編輯器畫格局，或上傳平面圖自動辨識</small>
        </button>
        <button type="button" className="gm-card" onClick={() => onPick("config")}>
          <span className="gm-ic">🏠</span>
          <b>系統配置</b>
          <small>選房數、坪數、幾廳幾衛，自動幫你蓋好房子</small>
        </button>
      </div>
    </div>
  )
}

function ConfigScreen({ onBack, onOpenEditor }: { onBack: () => void; onOpenEditor: () => void }) {
  const [cfg, setCfg] = useState<LayoutConfig>({ bedrooms: 2, livings: 1, baths: 1, kitchen: "open", seed: 1 })
  const range = useMemo(() => { try { return feasibleRange(cfg) } catch { return null } }, [cfg.bedrooms, cfg.livings, cfg.baths, cfg.kitchen])
  const res = useMemo((): { layout: GeneratedLayout | null; error: string | null } => {
    try { return { layout: generateLayout(cfg), error: null } } catch (e) {
      if (e instanceof BudgetError) return { layout: null, error: e.message }
      throw e
    }
  }, [cfg])
  const layout = res.layout
  const errs = useMemo(() => (layout ? validateLayout(layout) : []), [layout])
  // 自動家具（可替換：overrides[slotKey] = 款式 id）
  const [furnishOn, setFurnishOn] = useState(true)
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [sel, setSel] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => { setOverrides({}); setSel(null); setNote(null) }, [layout])
  const auto = useMemo(() => (layout && furnishOn && errs.length === 0 ? autoFurnish(layout) : null), [layout, furnishOn, errs])
  // 替換只動那一件：swapped＝替換後的整份清單（null＝用自動配置）
  const [swapped, setSwapped] = useState<GameFurniture[] | null>(null)
  useEffect(() => setSwapped(null), [auto])
  const furnished = useMemo(() => (auto ? { ...auto, items: swapped ?? auto.items } : null), [auto, swapped])
  const fErrs = useMemo(() => (layout && furnished ? validateFurniture(layout, furnished.items) : []), [layout, furnished])
  const selItem = furnished?.items.find((i) => i.id === sel) ?? null
  const swap = (variant: string) => {
    if (!layout || !selItem || !furnished) return
    const next = swapItem(layout, furnished.items, selItem.id, variant)
    if (!next) { setNote("這個款式放不下，保留原本的（其他家具沒有變動）"); return }
    setNote(null); setOverrides({ ...overrides, [selItem.slotKey]: variant }); setSwapped(next)
  }
  const shown = { ...cfg, ping: cfg.ping ?? layout?.config.ping }
  const reroll = () => { if (layout) setCfg({ ...cfg, ping: layout.config.ping, seed: nextDistinctSeed(layout.config, layout) }) }
  const openInEditor = () => {
    if (!layout) return
    try {
      const prev = JSON.parse(localStorage.getItem(BLUEPRINT_STORAGE_KEY) || "null")
      const sch = JSON.parse(localStorage.getItem(SCHEME_STORAGE_KEY) || "null")
      const hasWork = (prev && prev.source && prev.source !== "default") || (sch?.furniture?.length ?? 0) > 0
      if (hasWork && !confirm("以系統配置取代目前編輯器裡的戶型？目前的家具配置會被清空。")) return
      localStorage.setItem(BLUEPRINT_STORAGE_KEY, JSON.stringify(layout.blueprint))
      const items = furnished && fErrs.length === 0 ? furnished.items : []
      localStorage.setItem(SCHEME_STORAGE_KEY, JSON.stringify({ ...layout.scheme, furniture: toScheme(items) }))
      // 家具槽位／款式等遊戲用資訊另存（3D 走動、替換用）
      localStorage.setItem(GAME_FURNISH_KEY, JSON.stringify({ config: layout.config, overrides, items }))
    } catch { /* storage 不可用時仍進編輯器 */ }
    onOpenEditor()
  }
  const [playing, setPlaying] = useState(false)
  if (playing && layout && furnished) return <WalkFlow layout={layout} items={furnished.items} onExit={() => setPlaying(false)} />
  return (
    <div className="gm-screen gm-config">
      <header className="gm-bar">
        <button type="button" className="gm-link" onClick={onBack}>← 返回</button>
        <h2>系統配置</h2>
      </header>
      <div className="gm-config-body">
        <ConfigForm value={shown} range={range} onChange={setCfg} />
        <div className="gm-preview-wrap">
          {layout ? (
            <>
              <div className="gm-preview-head">
                <b>{layout.blueprint.name}</b>
                <span>室內 {layout.areaPing} 坪（不含陽台）＋陽台 {layout.balconyPing} 坪</span>
                <button type="button" className="gm-btn ghost" onClick={reroll}>🎲 換一個</button>
              </div>
              <PlanPreview layout={layout} items={furnished?.items} selected={sel} onPick={(it) => { setSel(it?.id ?? null); setNote(null) }} />
              {errs.length > 0 && <div className="gm-err">⚠️ {errs.join("；")}</div>}
              <div className="gm-furnish">
                <label><input type="checkbox" checked={furnishOn} onChange={(e) => setFurnishOn(e.target.checked)} /> 自動配家具</label>
                {furnished && !selItem && <small>點家具可以換款式</small>}
                {furnished && Object.keys(overrides).length > 0 && <button type="button" className="gm-link" onClick={() => { setOverrides({}); setSwapped(null) }}>還原預設家具</button>}
              </div>
              {selItem && (
                <div className="gm-swap">
                  <b>{selItem.name}</b>
                  {swapOptions(selItem).map((v) => (
                    <button key={v.id} type="button" className={`gm-chip${v.id === selItem.variant ? " on" : ""}`} onClick={() => swap(v.id)}>{v.name}<small>{(v.w / 10).toFixed(0)}×{(v.d / 10).toFixed(0)}</small></button>
                  ))}
                  {note && <span className="gm-err-inline">{note}</span>}
                </div>
              )}
              {furnished && furnished.missing.some((m) => /:(sofa|dining|bed|wardrobe|fridge|stove|counter|toilet)$/.test(m)) && (
                <div className="gm-note">空間不夠，沒擺：{[...new Set(furnished.missing.filter((m) => /:(sofa|dining|bed|wardrobe|fridge|stove|counter|toilet)$/.test(m)).map((m) => ({ sofa: "沙發", dining: "餐桌", bed: "床", wardrobe: "衣櫃", fridge: "冰箱", stove: "瓦斯爐", counter: "流理台", toilet: "馬桶" } as Record<string, string>)[m.split(":")[1]]))].join("、")}</div>
              )}
              {fErrs.length > 0 && <div className="gm-err">⚠️ 家具：{fErrs.slice(0, 3).join("；")}</div>}
            </>
          ) : <div className="gm-err gm-block">⚠️ {res.error}</div>}
          <div className="gm-actions">
            <button type="button" className="gm-btn ghost" onClick={openInEditor} disabled={!layout || errs.length > 0}>在編輯器開啟</button>
            <button type="button" className="gm-btn" onClick={() => setPlaying(true)} disabled={!layout || errs.length > 0 || !furnished || fErrs.length > 0} >下一步：選角色 →</button>
          </div>
        </div>
      </div>
    </div>
  )
}
