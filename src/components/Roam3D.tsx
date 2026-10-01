import { KeyboardControls, useKeyboardControls } from "@react-three/drei"
import { Canvas, useFrame, useThree } from "@react-three/fiber"
import { Component, useEffect, useMemo, useRef, type MutableRefObject, type ReactNode } from "react"
import type { Camera, Group, Mesh, Object3D } from "three"
import { Raycaster, Vector2 } from "three"
import {
  PLAYER_RADIUS,
  buildRoom,
  doorBlockers,
  isBlocked,
  type RoomModel,
  type SlidingDoor,
  type SwingDoor,
} from "../lib/scene/room.ts"
import type { Floorplan } from "../types/floorplan.ts"

const KEY_MAP = [
  { name: "forward", keys: ["KeyW", "ArrowUp"] },
  { name: "back", keys: ["KeyS", "ArrowDown"] },
  { name: "left", keys: ["KeyA", "ArrowLeft"] },
  { name: "right", keys: ["KeyD", "ArrowRight"] },
  { name: "use", keys: ["KeyE"] },
]

type MoveState = { f: number; b: number; l: number; r: number }
type Keys = { forward: boolean; back: boolean; left: boolean; right: boolean; use: boolean }

type Props = {
  plan: Floorplan
  onBack: () => void
}

export function Roam3D({ plan, onBack }: Props) {
  const model = useMemo(() => buildRoom(plan), [plan])
  const move = useRef<MoveState>({ f: 0, b: 0, l: 0, r: 0 })
  const api = useRef({ toggleAimed: () => {} })

  useEffect(() => {
    const block = (event: KeyboardEvent) => {
      if (
        event.code === "KeyW" ||
        event.code === "KeyA" ||
        event.code === "KeyS" ||
        event.code === "KeyD" ||
        event.code === "KeyE" ||
        event.code.startsWith("Arrow") ||
        event.code === "Space"
      ) {
        event.preventDefault()
      }
    }
    window.addEventListener("keydown", block)
    return () => window.removeEventListener("keydown", block)
  }, [])

  if (model.solids.length === 0) {
    return (
      <div className="flex h-[72vh] min-h-[420px] flex-col items-start justify-center gap-3 rounded-xl border border-[#ddd4c6] bg-[#f7f3ea] px-6">
        <p className="text-sm text-[#3f3a34]">這張圖沒有能立起來的牆，進不了房間。</p>
        <button type="button" onClick={onBack} className="rounded-lg bg-[#1f3a5f] px-3 py-1.5 text-sm text-[#f7f3ea]">
          回到 2D
        </button>
      </div>
    )
  }

  const hold = (key: keyof MoveState, value: number) => {
    move.current[key] = value
  }

  return (
    <ViewError onBack={onBack}>
      <div className="relative h-[72vh] min-h-[480px] overflow-hidden rounded-xl border border-[#cfc6b8] bg-[#d7d0c4]">
        <KeyboardControls map={KEY_MAP}>
          <Canvas
            camera={{ fov: 72, near: 0.08, far: 120, position: [model.spawn.x, model.spawn.eye, model.spawn.z] }}
            dpr={[1, 1.75]}
            gl={{ antialias: true }}
          >
            <color attach="background" args={["#d7d0c4"]} />
            <Scene model={model} move={move} api={api} />
          </Canvas>
        </KeyboardControls>

        <div className="pointer-events-none absolute left-1/2 top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2">
          <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[#1c1917]/70" />
          <div className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-[#1c1917]/70" />
        </div>

        <div className="pointer-events-none absolute top-3 left-3 max-w-[16rem] rounded-lg bg-[#1c1917]/75 px-3 py-2 text-xs leading-5 text-[#f7f3ea]">
          拖曳改變視角，指標不會被鎖住。WASD 移動。對準門按 E，或輕點門扇。
        </div>
        <div className="absolute top-3 right-3 flex gap-2">
          <button
            type="button"
            onClick={() => api.current.toggleAimed()}
            className="rounded-lg bg-[#1c1917]/80 px-3 py-1.5 text-sm text-[#f7f3ea]"
          >
            開門
          </button>
          <button type="button" onClick={onBack} className="rounded-lg bg-[#f7f3ea] px-3 py-1.5 text-sm text-[#1c1917]">
            回到 2D
          </button>
        </div>

        <div className="absolute bottom-3 left-3 grid grid-cols-3 gap-1 md:hidden">
          <span />
          <MoveButton label="前" onDown={() => hold("f", 1)} onUp={() => hold("f", 0)} />
          <span />
          <MoveButton label="左" onDown={() => hold("l", 1)} onUp={() => hold("l", 0)} />
          <MoveButton label="後" onDown={() => hold("b", 1)} onUp={() => hold("b", 0)} />
          <MoveButton label="右" onDown={() => hold("r", 1)} onUp={() => hold("r", 0)} />
        </div>
      </div>
    </ViewError>
  )
}

function MoveButton({ label, onDown, onUp }: { label: string; onDown: () => void; onUp: () => void }) {
  return (
    <button
      type="button"
      className="h-11 w-11 rounded-lg bg-[#1c1917]/80 text-sm text-[#f7f3ea]"
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        onDown()
      }}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerLeave={onUp}
    >
      {label}
    </button>
  )
}

function Scene({
  model,
  move,
  api,
}: {
  model: RoomModel
  move: MutableRefObject<MoveState>
  api: MutableRefObject<{ toggleAimed: () => void }>
}) {
  const { minX, maxX, minZ, maxZ } = model.bounds
  const pad = 1.6
  const width = maxX - minX + pad * 2
  const depth = maxZ - minZ + pad * 2
  const cx = (minX + maxX) / 2
  const cz = (minZ + maxZ) / 2
  return (
    <>
      <ambientLight intensity={0.55} />
      <hemisphereLight args={["#f4efe6", "#b7aa96", 0.45]} />
      <directionalLight position={[cx + 6, model.ceiling + 8, cz + 4]} intensity={1.05} />
      <mesh position={[cx, -0.04, cz]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#cbbfaa" />
      </mesh>
      <mesh position={[cx, model.ceiling, cz]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#f3efe6" side={2} />
      </mesh>
      {model.solids.map((solid) => (
        <mesh key={solid.id} position={[solid.center.x, solid.center.y, solid.center.z]} rotation={[0, solid.yaw, 0]}>
          <boxGeometry args={[solid.size.x, solid.size.y, solid.size.z]} />
          <meshStandardMaterial color={solid.role === "wall" ? "#e6dfd2" : "#ddd4c6"} roughness={0.92} />
        </mesh>
      ))}
      {model.glass.map((pane) => (
        <mesh key={pane.id} position={[pane.center.x, pane.center.y, pane.center.z]} rotation={[0, pane.yaw, 0]}>
          <boxGeometry args={[pane.size.x, pane.size.y, pane.size.z]} />
          <meshStandardMaterial color="#c5e4f2" transparent opacity={0.38} roughness={0.05} metalness={0.05} depthWrite={false} />
        </mesh>
      ))}
      <Walker model={model} move={move} api={api} />
    </>
  )
}

function Walker({
  model,
  move,
  api,
}: {
  model: RoomModel
  move: MutableRefObject<MoveState>
  api: MutableRefObject<{ toggleAimed: () => void }>
}) {
  const { camera, gl, scene } = useThree()
  const getKeys = useKeyboardControls()[1] as () => Keys
  const pos = useRef({ x: model.spawn.x, z: model.spawn.z })
  const yaw = useRef(model.spawn.yaw)
  const pitch = useRef(0)
  const dragging = useRef(false)
  const last = useRef({ x: 0, y: 0 })
  const dragDist = useRef(0)
  const click = useRef<{ x: number; y: number } | null>(null)
  const openTarget = useRef<Record<string, boolean>>({})
  const openAmount = useRef<Record<string, number>>({})
  const prevUse = useRef(false)
  const swingRefs = useRef(new Map<string, Group>())
  const sliderRefs = useRef(new Map<string, Mesh>())
  const raycaster = useRef(new Raycaster())
  const pointer = useRef(new Vector2())

  const toggle = (id: string) => {
    openTarget.current[id] = !openTarget.current[id]
  }

  const toggleAimed = () => {
    const id = aimedDoor(model, pos.current.x, pos.current.z, yaw.current)
    if (id) toggle(id)
  }
  api.current.toggleAimed = toggleAimed

  useEffect(() => {
    pos.current = { x: model.spawn.x, z: model.spawn.z }
    yaw.current = model.spawn.yaw
    pitch.current = 0
    openTarget.current = {}
    openAmount.current = {}
    camera.position.set(model.spawn.x, model.spawn.eye, model.spawn.z)
    camera.rotation.order = "YXZ"
    camera.rotation.y = model.spawn.yaw
    camera.rotation.x = 0
  }, [model, camera])

  useEffect(() => {
    const el = gl.domElement
    el.style.touchAction = "none"
    el.style.cursor = "grab"
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return
      dragging.current = true
      dragDist.current = 0
      last.current = { x: event.clientX, y: event.clientY }
      el.setPointerCapture(event.pointerId)
      el.style.cursor = "grabbing"
    }
    const movePtr = (event: PointerEvent) => {
      if (!dragging.current) return
      const dx = event.clientX - last.current.x
      const dy = event.clientY - last.current.y
      last.current = { x: event.clientX, y: event.clientY }
      dragDist.current += Math.abs(dx) + Math.abs(dy)
      yaw.current -= dx * 0.005
      pitch.current = Math.max(-1.15, Math.min(1.15, pitch.current - dy * 0.005))
    }
    const up = (event: PointerEvent) => {
      if (!dragging.current) return
      dragging.current = false
      el.style.cursor = "grab"
      if (dragDist.current < 6) click.current = { x: event.clientX, y: event.clientY }
    }
    el.addEventListener("pointerdown", down)
    el.addEventListener("pointermove", movePtr)
    el.addEventListener("pointerup", up)
    el.addEventListener("pointercancel", up)
    return () => {
      el.removeEventListener("pointerdown", down)
      el.removeEventListener("pointermove", movePtr)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
    }
  }, [gl])

  useFrame((_, delta) => {
    const keys = getKeys()
    const step = Math.min(delta, 0.05)
    const sy = Math.sin(yaw.current)
    const cy = Math.cos(yaw.current)
    let fx = 0
    let fz = 0
    const pad = move.current
    if (keys.forward || pad.f) {
      fx += -sy
      fz += -cy
    }
    if (keys.back || pad.b) {
      fx -= -sy
      fz -= -cy
    }
    if (keys.left || pad.l) {
      fx -= cy
      fz -= -sy
    }
    if (keys.right || pad.r) {
      fx += cy
      fz += -sy
    }
    const mag = Math.hypot(fx, fz)
    if (mag > 0) {
      const speed = 2.5 * step
      fx = (fx / mag) * speed
      fz = (fz / mag) * speed
      const segs = [...model.collision, ...doorBlockers(model, openAmount.current)]
      const nx = pos.current.x + fx
      if (!isBlocked(nx, pos.current.z, PLAYER_RADIUS, segs)) pos.current.x = nx
      const nz = pos.current.z + fz
      if (!isBlocked(pos.current.x, nz, PLAYER_RADIUS, segs)) pos.current.z = nz
      const margin = 3
      pos.current.x = clamp(pos.current.x, model.bounds.minX - margin, model.bounds.maxX + margin)
      pos.current.z = clamp(pos.current.z, model.bounds.minZ - margin, model.bounds.maxZ + margin)
    }
    camera.position.set(pos.current.x, model.spawn.eye, pos.current.z)
    camera.rotation.order = "YXZ"
    camera.rotation.y = yaw.current
    camera.rotation.x = pitch.current

    const ids = [...model.swings.map((door) => door.id), ...model.sliders.map((door) => door.id)]
    for (const id of ids) {
      const target = openTarget.current[id] ? 1 : 0
      const current = openAmount.current[id] ?? 0
      const diff = target - current
      openAmount.current[id] = current + Math.sign(diff) * Math.min(Math.abs(diff), step * 2.4)
    }
    for (const door of model.swings) {
      const group = swingRefs.current.get(door.id)
      if (!group) continue
      group.rotation.y = door.yawClosed + door.openYaw * (openAmount.current[door.id] ?? 0)
    }
    for (const door of model.sliders) {
      const amount = openAmount.current[door.id] ?? 0
      door.leaves.forEach((leaf, index) => {
        const mesh = sliderRefs.current.get(`${door.id}:${index}`)
        if (!mesh) return
        mesh.position.x = leaf.x + leaf.slideX * amount
        mesh.position.z = leaf.z + leaf.slideZ * amount
      })
    }

    if (keys.use && !prevUse.current) toggleAimed()
    prevUse.current = !!keys.use

    const hit = click.current
    if (hit) {
      click.current = null
      camera.updateMatrixWorld(true)
      const id = doorUnderPointer(hit.x, hit.y, gl.domElement, camera, scene, raycaster.current, pointer.current)
      if (id) toggle(id)
    }
  })

  return (
    <>
      {model.swings.map((door) => (
        <group
          key={door.id}
          ref={(node) => {
            if (node) swingRefs.current.set(door.id, node)
            else swingRefs.current.delete(door.id)
          }}
          position={[door.hingeX, 0, door.hingeZ]}
          rotation={[0, door.yawClosed, 0]}
        >
          <mesh position={[door.length / 2, door.height / 2, 0]} userData={{ doorId: door.id }} castShadow={false}>
            <boxGeometry args={[door.length, door.height, door.thickness]} />
            <meshStandardMaterial color="#7a4e34" roughness={0.8} />
          </mesh>
        </group>
      ))}
      {model.sliders.map((door) =>
        door.leaves.map((leaf, index) => (
          <mesh
            key={`${door.id}:${index}`}
            ref={(node) => {
              const key = `${door.id}:${index}`
              if (node) sliderRefs.current.set(key, node)
              else sliderRefs.current.delete(key)
            }}
            position={[leaf.x, door.height / 2, leaf.z]}
            rotation={[0, leaf.yaw, 0]}
            userData={{ doorId: door.id }}
          >
            <boxGeometry args={[leaf.length, door.height, leaf.thickness]} />
            <meshStandardMaterial color={index === 0 ? "#6d5648" : "#7d6554"} roughness={0.75} />
          </mesh>
        )),
      )}
    </>
  )
}

function aimedDoor(model: RoomModel, x: number, z: number, yaw: number): string | null {
  const fx = -Math.sin(yaw)
  const fz = -Math.cos(yaw)
  let best: string | null = null
  let bestD = 2.6
  const doors: { id: string; x: number; z: number }[] = [
    ...model.swings.map((door: SwingDoor) => ({ id: door.id, x: door.focusX, z: door.focusZ })),
    ...model.sliders.map((door: SlidingDoor) => ({ id: door.id, x: door.focusX, z: door.focusZ })),
  ]
  for (const door of doors) {
    const dx = door.x - x
    const dz = door.z - z
    const d = Math.hypot(dx, dz)
    if (d > bestD || d < 0.05) continue
    const dot = (dx / d) * fx + (dz / d) * fz
    if (dot < 0.45) continue
    best = door.id
    bestD = d
  }
  return best
}

function doorUnderPointer(
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement,
  camera: Camera,
  scene: Object3D,
  raycaster: Raycaster,
  pointer: Vector2,
): string | null {
  const rect = canvas.getBoundingClientRect()
  if (rect.width < 1 || rect.height < 1) return null
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const targets: Object3D[] = []
  scene.traverse((obj) => {
    if (obj.userData.doorId) targets.push(obj)
  })
  const hit = raycaster.intersectObjects(targets, false)[0]
  const id = hit?.object.userData.doorId
  return typeof id === "string" ? id : null
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

class ViewError extends Component<{ children: ReactNode; onBack: () => void }, { message: string | null }> {
  state = { message: null as string | null }

  static getDerivedStateFromError(error: Error) {
    return { message: error.message }
  }

  render() {
    if (!this.state.message) return this.props.children
    return (
      <div className="flex h-[72vh] min-h-[420px] flex-col items-start justify-center gap-3 rounded-xl border border-[#ddd4c6] bg-[#fde8e6] px-6">
        <p className="text-sm text-[#9f1239]">這個環境開不了 3D。{this.state.message}</p>
        <button type="button" onClick={this.props.onBack} className="rounded-lg bg-[#1f3a5f] px-3 py-1.5 text-sm text-[#f7f3ea]">
          回到 2D
        </button>
      </div>
    )
  }
}
