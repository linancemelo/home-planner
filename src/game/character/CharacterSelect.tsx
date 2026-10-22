/** 選角色 → 身高體重 → 漫遊。角色縮圖用同一個離屏 renderer 畫成圖片；大預覽是一個會轉的 3D 舞台。 */
import { useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"
import { applyBody, buildAvatar } from "./avatar.ts"
import { bodyMetrics, CHARACTERS, parseBodyNum, HEIGHT_RANGE, PLAYER_KEY, validBody, WEIGHT_RANGE, type Body, type CharacterPreset, type PlayerSetup } from "./characters.ts"

function stageScene() {
  const scene = new THREE.Scene()
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9c9b4, 1.6))
  const sun = new THREE.DirectionalLight(0xffffff, 1.4)
  sun.position.set(1.5, 3, 2.5)
  scene.add(sun)
  const floor = new THREE.Mesh(new THREE.CircleGeometry(0.9, 40), new THREE.MeshStandardMaterial({ color: 0xf1e2cc }))
  floor.rotation.x = -Math.PI / 2
  scene.add(floor)
  return scene
}

/** 6 張縮圖（data URL）。 */
function useThumbs() {
  return useMemo(() => {
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
      r.setSize(220, 260)
      const cam = new THREE.PerspectiveCamera(30, 220 / 260, 0.1, 20)
      cam.position.set(0.9, 1.25, 3.2); cam.lookAt(0, 0.72, 0)
      const out: Record<string, string> = {}
      for (const c of CHARACTERS) {
        const scene = stageScene(), a = buildAvatar(c)
        a.group.rotation.y = 0.35
        a.group.scale.setScalar(1.45)
        scene.add(a.group)
        r.render(scene, cam)
        out[c.id] = r.domElement.toDataURL("image/png")
      }
      r.dispose()
      return out
    } catch { return {} as Record<string, string> }
  }, [])
}

function AvatarStage({ preset, body }: { preset: CharacterPreset; body: Body }) {
  const host = useRef<HTMLDivElement>(null)
  const bodyRef = useRef(body)
  bodyRef.current = body
  useEffect(() => {
    const el = host.current!
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    r.setPixelRatio(Math.min(2, devicePixelRatio))
    el.appendChild(r.domElement)
    const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 30)
    const scene = stageScene(), a = buildAvatar(preset)
    scene.add(a.group)
    // 參考身高尺：門高 2.1 m
    const ref = new THREE.Mesh(new THREE.BoxGeometry(0.04, 2.1, 0.04), new THREE.MeshStandardMaterial({ color: 0xc0612f }))
    ref.position.set(-0.75, 1.05, -0.2)
    scene.add(ref)
    const resize = () => { const w = el.clientWidth, h = el.clientHeight; r.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix() }
    resize(); addEventListener("resize", resize)
    let raf = 0
    const loop = (t: number) => {
      const m = bodyMetrics(bodyRef.current)
      applyBody(a.group, m.heightM, m.width)
      a.group.rotation.y = Math.sin(t / 1600) * 0.7
      a.animate(t / 1000, 0)
      cam.position.set(0, 1.25, 4.6); cam.lookAt(0, 1.0, 0)
      r.render(scene, cam)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => { cancelAnimationFrame(raf); removeEventListener("resize", resize); r.dispose(); el.removeChild(r.domElement) }
  }, [preset])
  return <div className="gm-stage" ref={host} />
}

export function loadPlayer(): PlayerSetup {
  try {
    const p = JSON.parse(localStorage.getItem(PLAYER_KEY) || "null") as PlayerSetup | null
    if (p && CHARACTERS.some((c) => c.id === p.character) && !validBody(p.body)) return p
  } catch { /* 沒存過 */ }
  return { character: CHARACTERS[0].id, body: { heightCm: CHARACTERS[0].height, weightKg: CHARACTERS[0].weight } }
}

export function CharacterStep({ value, onBack, onNext }: { value: PlayerSetup; onBack: () => void; onNext: (p: PlayerSetup) => void }) {
  const thumbs = useThumbs()
  const [sel, setSel] = useState(value.character)
  const preset = CHARACTERS.find((c) => c.id === sel)!
  const pick = (c: CharacterPreset) => setSel(c.id)
  return (
    <div className="gm-screen gm-char">
      <header className="gm-bar">
        <button type="button" className="gm-link" onClick={onBack}>← 回格局</button>
        <h2>選角色</h2>
        <span className="gm-steps">格局 › <b>選角色</b> › 身高體重 › 漫遊</span>
      </header>
      <div className="gm-char-body">
        <div className="gm-char-grid">
          {CHARACTERS.map((c) => (
            <button key={c.id} type="button" className={`gm-char-card${c.id === sel ? " on" : ""}`} onClick={() => pick(c)} onDoubleClick={() => onNext({ character: c.id, body: { heightCm: c.height, weightKg: c.weight } })}>
              {thumbs[c.id] ? <img src={thumbs[c.id]} alt={c.name} /> : <div className="gm-thumb-ph" style={{ background: c.top }} />}
              <b>{c.name} <small>{c.gender === "male" ? "♂" : "♀"}</small></b>
              <span>{c.blurb}</span>
            </button>
          ))}
        </div>
        <div className="gm-char-side">
          <AvatarStage preset={preset} body={{ heightCm: preset.height, weightKg: preset.weight }} />
          <button type="button" className="gm-btn gm-next" onClick={() => onNext({ character: sel, body: sel === value.character ? value.body : { heightCm: preset.height, weightKg: preset.weight } })}>選 {preset.name}，下一步 →</button>
        </div>
      </div>
    </div>
  )
}

export function BodyStep({ value, onBack, onNext }: { value: PlayerSetup; onBack: () => void; onNext: (p: PlayerSetup) => void }) {
  const preset = CHARACTERS.find((c) => c.id === value.character)!
  const [h, setH] = useState(String(value.body.heightCm))
  const [w, setW] = useState(String(value.body.weightKg))
  const body: Body = { heightCm: parseBodyNum(h), weightKg: parseBodyNum(w) }
  const err = validBody(body)
  const m = bodyMetrics(err ? value.body : body)
  return (
    <div className="gm-screen gm-char">
      <header className="gm-bar">
        <button type="button" className="gm-link" onClick={onBack}>← 回選角色</button>
        <h2>身高體重</h2>
        <span className="gm-steps">格局 › 選角色 › <b>身高體重</b> › 漫遊</span>
      </header>
      <div className="gm-char-body">
        <div className="gm-body-form">
          <label>身高 <input type="number" inputMode="numeric" min={HEIGHT_RANGE[0]} max={HEIGHT_RANGE[1]} value={h} onChange={(e) => setH(e.target.value)} /> cm</label>
          <input type="range" min={HEIGHT_RANGE[0]} max={HEIGHT_RANGE[1]} value={Number(h) || HEIGHT_RANGE[0]} onChange={(e) => setH(e.target.value)} />
          <label>體重 <input type="number" inputMode="numeric" min={WEIGHT_RANGE[0]} max={WEIGHT_RANGE[1]} value={w} onChange={(e) => setW(e.target.value)} /> kg</label>
          <input type="range" min={WEIGHT_RANGE[0]} max={WEIGHT_RANGE[1]} value={Number(w) || WEIGHT_RANGE[0]} onChange={(e) => setW(e.target.value)} />
          {err ? <div className="gm-err">⚠️ {err}</div> : <p className="gm-sub">眼睛高度約 {(m.eyeMm / 1000).toFixed(2)} m（第一人稱視角），身形寬度 ×{m.width.toFixed(2)}（BMI {m.bmi}）。門高 2.1 m、天花板 2.8 m。</p>}
        </div>
        <div className="gm-char-side">
          <AvatarStage preset={preset} body={err ? value.body : body} />
          <button type="button" className="gm-btn gm-next" disabled={!!err} onClick={() => { const p = { ...value, body }; try { localStorage.setItem(PLAYER_KEY, JSON.stringify(p)) } catch { /* 無法存 */ } onNext(p) }}>進去逛逛 →</button>
        </div>
      </div>
    </div>
  )
}
