/** 3D 走動：拖曳轉視角（不鎖滑鼠）、WASD／方向鍵＋Shift 跑、手機左半邊搖桿右半邊轉頭、E 或按鈕開關門窗冰箱。 */
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import type { GeneratedLayout } from "../layout/types.ts"
import type { GameFurniture } from "../furnish/autoFurnish.ts"
import { buildScene } from "./buildScene.ts"
import { blocked, colliders, makeInteractables, move, nearest, roomAt, stepBack, type Interactable } from "./walk.ts"
import { bodyMetrics, CHARACTERS, type PlayerSetup } from "../character/characters.ts"
import { applyBody, buildAvatar } from "../character/avatar.ts"
/** 直式手機：加大垂直 FOV，讓水平視角至少約 75°（出生時大門不會塞滿畫面）；橫式維持 70°。 */
const portraitFov = (aspect: number) => aspect >= 1 ? 70 : Math.min(100, Math.max(70, (2 * Math.atan(Math.tan((75 * Math.PI) / 360) / aspect) * 180) / Math.PI))

const WALK = 1400, RUN = 3000 // mm/s
const verb = (s: Interactable) => (s.open ? "關" : "開") + (s.kind === "swing" ? "門" : s.kind === "slide" ? "落地窗" : s.kind === "window" ? "窗" : "冰箱")

export function PlayScreen({ layout, items, player, onBack }: { layout: GeneratedLayout; items: GameFurniture[]; player: PlayerSetup; onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const [third, setThird] = useState(false)
  const thirdRef = useRef(third)
  thirdRef.current = third
  const [hud, setHud] = useState<{ room: string | null; near: Interactable | null; msg: string | null }>({ room: null, near: null, msg: null })
  const act = useRef<() => void>(() => {})
  const joyBase = useRef<HTMLDivElement>(null), joyKnob = useRef<HTMLDivElement>(null)
  // 觸控裝置（粗指標或支援觸控）才顯示搖桿與觸控說明
  const [touch] = useState(() => typeof window !== "undefined" && (matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window || navigator.maxTouchPoints > 0))
  useEffect(() => {
    const el = host.current!
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(2, devicePixelRatio))
    el.appendChild(renderer.domElement)
    const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 200)
    const h = buildScene(layout, items)
    const bm = bodyMetrics(player.body), eye = bm.eyeMm
    const av = buildAvatar(CHARACTERS.find((c) => c.id === player.character) ?? CHARACTERS[0])
    applyBody(av.group, bm.heightM, bm.width)
    h.scene.add(av.group)
    let moving = 0, clock = 0
    const st = makeInteractables(layout, items)
    let boxes = colliders(layout, items, st)
    let pos: [number, number] = [...layout.spawn.at]
    let yaw = Math.atan2(-(layout.spawn.lookAt[0] - pos[0]), -(layout.spawn.lookAt[1] - pos[1])), pitch = 0
    const keys = new Set<string>()
    const joy = { id: -1, x0: 0, y0: 0, dx: 0, dy: 0 }
    const look = { id: -1, x: 0, y: 0 }
    let msgT = 0, lastHud = ""
    const resize = () => { const w = el.clientWidth, hh = el.clientHeight; renderer.setSize(w, hh); cam.aspect = w / hh; cam.fov = portraitFov(cam.aspect); cam.updateProjectionMatrix() }
    resize()
    addEventListener("resize", resize)
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (e.type === "keydown") {
        keys.add(k)
        if (e.repeat) return
        if (k === "e" || k === " ") { e.preventDefault(); act.current() }
        if (k === "v") setThird((x) => !x)
      } else keys.delete(k)
    }
    addEventListener("keydown", onKey); addEventListener("keyup", onKey)
    const cv = renderer.domElement
    cv.style.touchAction = "none"
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch" && e.clientX < el.clientWidth / 2 && joy.id < 0) { joy.id = e.pointerId; joy.x0 = e.clientX; joy.y0 = e.clientY; joy.dx = joy.dy = 0; showJoy() }
      else if (look.id < 0) { look.id = e.pointerId; look.x = e.clientX; look.y = e.clientY }
      cv.setPointerCapture(e.pointerId)
    }
    // 可見的搖桿：閒置時停在左下角；按下時底座移到手指位置，把手跟著推
    const jb = joyBase.current, jk = joyKnob.current
    const showJoy = () => {
      if (!jb || !jk) return
      if (joy.id >= 0) { const r = el.getBoundingClientRect(); jb.style.left = `${joy.x0 - r.left}px`; jb.style.top = `${joy.y0 - r.top}px`; jb.style.bottom = "auto"; jb.classList.add("on") }
      else { jb.style.left = ""; jb.style.top = ""; jb.style.bottom = ""; jb.classList.remove("on") }
      jk.style.transform = `translate(${joy.dx * 40}px, ${joy.dy * 40}px)`
    }
    const mv = (e: PointerEvent) => {
      if (e.pointerId === joy.id) { joy.dx = Math.max(-1, Math.min(1, (e.clientX - joy.x0) / 60)); joy.dy = Math.max(-1, Math.min(1, (e.clientY - joy.y0) / 60)); showJoy() }
      else if (e.pointerId === look.id) {
        yaw -= (e.clientX - look.x) * 0.005; pitch = Math.max(-1.2, Math.min(1.2, pitch - (e.clientY - look.y) * 0.005))
        look.x = e.clientX; look.y = e.clientY
      }
    }
    const up = (e: PointerEvent) => { if (e.pointerId === joy.id) { joy.id = -1; joy.dx = joy.dy = 0; showJoy() } if (e.pointerId === look.id) look.id = -1 }
    cv.addEventListener("pointerdown", down); cv.addEventListener("pointermove", mv); cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up)
    // 可操作物件：距離、面向、視線都要符合（不能隔牆開冰箱）
    const usable = () => nearest(st, pos, 1600, layout, [-Math.sin(yaw), -Math.cos(yaw)])
    act.current = () => {
      const n = usable()
      if (!n) return
      n.open = !n.open
      const nb = colliders(layout, items, st)
      if (!blocked(pos[0], pos[1], boxes) && blocked(pos[0], pos[1], nb)) {
        // 門片會掃到人：沿路用碰撞往後退（walk.ts stepBack），不瞬移穿牆；退不了就不開並提示
        const q = stepBack(layout, pos, n.at, boxes, nb)
        const moved = !!q
        if (q) pos = q
        if (!moved) { n.open = !n.open; msgT = 1.5; setHud((s) => ({ ...s, msg: "先讓開一點再開關" })); return }
      }
      boxes = nb
      h.apply(st)
    }
    let raf = 0, t0 = performance.now()
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - t0) / 1000); t0 = t
      let f = 0, s = 0
      if (keys.has("w") || keys.has("arrowup")) f += 1
      if (keys.has("s") || keys.has("arrowdown")) f -= 1
      if (keys.has("d") || keys.has("arrowright")) s += 1
      if (keys.has("a") || keys.has("arrowleft")) s -= 1
      if (keys.has("q")) yaw += 2 * dt
      if (keys.has("r")) yaw -= 2 * dt
      if (joy.id >= 0) { f -= joy.dy; s += joy.dx }
      const mag = Math.hypot(f, s)
      if (mag > 0.05) {
        const sp = (keys.has("shift") || Math.hypot(joy.dx, joy.dy) > 0.95 ? RUN : WALK) * dt / Math.max(1, mag)
        // yaw＝0 時看向 -z（平面 y 減少）
        const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw)
        pos = move(pos, (fx * f + rx * s) * sp, (fz * f + rz * s) * sp, boxes)
      }
      clock += dt
      moving += ((mag > 0.05 ? 1 : 0) - moving) * Math.min(1, dt * 10)
      av.group.position.set(pos[0] / 1000, 0, pos[1] / 1000)
      av.group.rotation.y = yaw + Math.PI
      av.animate(clock, moving)
      av.group.visible = thirdRef.current
      if (!thirdRef.current) {
        cam.position.set(pos[0] / 1000, eye / 1000, pos[1] / 1000)
        cam.rotation.set(pitch, yaw, 0, "YXZ")
      } else {
        // 第三人稱：在角色背後，碰到牆就拉近
        const bx = Math.sin(yaw), bz = Math.cos(yaw), want = 1600 + bm.heightM * 500
        let d = 300
        while (d < want && !blocked(pos[0] + bx * (d + 100), pos[1] + bz * (d + 100), boxes, 120)) d += 100
        const camY = Math.min(2600, eye + 450 - pitch * 900)
        cam.position.set((pos[0] + bx * d) / 1000, camY / 1000, (pos[1] + bz * d) / 1000)
        cam.lookAt(pos[0] / 1000, (eye * 0.85) / 1000, pos[1] / 1000)
      }
      h.tick(dt)
      renderer.render(h.scene, cam)
      if (msgT > 0) msgT -= dt
      const room = roomAt(layout, pos), n = usable(), key = `${room}|${n ? n.kind + n.name + n.open : ""}|${msgT > 0}`
      if (key !== lastHud) { lastHud = key; setHud((x) => ({ room, near: n, msg: msgT > 0 ? x.msg : null })) }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    // 除錯 hook 只在非正式版（dev／--mode e2e）存在；正式版整段被 tree-shake 掉
    if (import.meta.env.MODE !== "production") (window as unknown as { __game?: unknown }).__game = { get pos() { return pos }, get yaw() { return yaw }, layout, st, act: () => act.current(), teleport: (p: [number, number], y: number) => { pos = p; yaw = y } }
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener("resize", resize); removeEventListener("keydown", onKey); removeEventListener("keyup", onKey)
      h.dispose(); renderer.dispose(); el.removeChild(cv)
    }
  }, [layout, items, player])
  return (
    <div className="gm-play" ref={host}>
      <div className="gm-hud">
        <button type="button" className="gm-btn ghost" onClick={onBack}>← 回配置</button>
        <span className="gm-room">{hud.room ?? "戶外"}</span>
        <button type="button" className="gm-btn ghost gm-view" onClick={() => setThird((x) => !x)}>{third ? "👀 第一人稱" : "🧍 第三人稱"} <kbd>V</kbd></button>
      </div>
      {hud.near && <button type="button" className="gm-act" onClick={() => act.current()}>{verb(hud.near)}{hud.near.kind === "swing" && hud.near.name ? `（${hud.near.name}）` : ""} <kbd>E</kbd></button>}
      {hud.msg && <div className="gm-toast">{hud.msg}</div>}
      {touch && <div className="gm-joy" ref={joyBase}><div className="gm-joy-knob" ref={joyKnob} /></div>}
      <div className="gm-help">{touch ? "左下搖桿走（推到底跑）· 右半邊拖曳轉頭 · 點按鈕開關 · 右上切換視角" : "拖曳轉視角 · WASD／方向鍵走 · Shift 跑 · E 開關 · V 切換視角"}</div>
    </div>
  )
}
