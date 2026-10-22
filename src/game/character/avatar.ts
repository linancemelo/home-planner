/** 用基本幾何體組 Q 版角色（頭大身小）。模型高 1（腳底 y=0），正面朝 +z；由外部依身高體重縮放。 */
import * as THREE from "three"
import type { CharacterPreset } from "./characters.ts"

const std = (c: string, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, ...o })
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m)
  o.position.set(x, y, z)
  o.castShadow = true
  return o
}

export type Avatar = { group: THREE.Group; animate: (t: number, moving: number) => void }

export function buildAvatar(p: CharacterPreset): Avatar {
  const g = new THREE.Group()
  const skin = std(p.skin), hair = std(p.hair, { roughness: 0.6 }), top = std(p.top), bottom = std(p.bottom), shoe = std(p.shoes), accent = std(p.accent)
  const black = std("#1d1d1f", { roughness: 0.3 }), white = std("#ffffff", { roughness: 0.2 }), blush = std("#ff9aa8", { transparent: true, opacity: 0.6 })
  // 腿（可擺動）
  const legs: THREE.Group[] = []
  for (const s of [-1, 1]) {
    const leg = new THREE.Group()
    leg.position.set(s * 0.055, 0.34, 0)
    leg.add(mesh(new THREE.CylinderGeometry(0.042, 0.038, 0.3, 12), p.skirt ? skin : bottom, 0, -0.15, 0))
    leg.add(mesh(new THREE.SphereGeometry(0.055, 14, 10).scale(1, 0.6, 1.5), shoe, 0, -0.31, 0.025))
    g.add(leg); legs.push(leg)
  }
  // 身體
  g.add(mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.28, 18), top, 0, 0.5, 0))
  if (p.skirt) g.add(mesh(new THREE.ConeGeometry(0.17, 0.17, 20, 1, true), bottom, 0, 0.36, 0))
  else g.add(mesh(new THREE.CylinderGeometry(0.12, 0.115, 0.08, 18), bottom, 0, 0.36, 0))
  g.add(mesh(new THREE.SphereGeometry(0.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), top, 0, 0.635, 0)) // 肩膀
  g.add(mesh(new THREE.SphereGeometry(0.018, 8, 6), accent, 0, 0.56, 0.11)) // 胸前小釦
  // 手（可擺動）
  const arms: THREE.Group[] = []
  for (const s of [-1, 1]) {
    const arm = new THREE.Group()
    arm.position.set(s * 0.125, 0.63, 0)
    arm.rotation.z = s * 0.18
    arm.add(mesh(new THREE.CylinderGeometry(0.032, 0.03, 0.24, 10), top, 0, -0.12, 0))
    arm.add(mesh(new THREE.SphereGeometry(0.038, 12, 8), skin, 0, -0.26, 0))
    g.add(arm); arms.push(arm)
  }
  // 頭（大頭＝可愛）
  const head = new THREE.Group()
  head.position.y = 0.83
  head.add(mesh(new THREE.SphereGeometry(0.17, 28, 20), skin))
  for (const s of [-1, 1]) {
    head.add(mesh(new THREE.SphereGeometry(0.03, 14, 10).scale(1, 1.25, 0.6), black, s * 0.062, -0.01, 0.155))
    head.add(mesh(new THREE.SphereGeometry(0.01, 8, 6), white, s * 0.062 + 0.01, 0.012, 0.172))
    head.add(mesh(new THREE.SphereGeometry(0.028, 12, 8).scale(1.2, 0.6, 0.3), blush, s * 0.1, -0.055, 0.14))
    head.add(mesh(new THREE.SphereGeometry(0.03, 10, 8), skin, s * 0.168, -0.01, 0)) // 耳朵
  }
  const smile = mesh(new THREE.TorusGeometry(0.025, 0.006, 6, 16, Math.PI), std("#b5534a"), 0, -0.065, 0.158)
  smile.rotation.z = Math.PI
  head.add(smile)
  if (p.glasses) for (const s of [-1, 1]) head.add(mesh(new THREE.TorusGeometry(0.042, 0.006, 6, 20), black, s * 0.062, -0.005, 0.165))
  // 頭髮
  const cap = (r: number, theta: number) => mesh(new THREE.SphereGeometry(r, 28, 16, 0, Math.PI * 2, 0, theta), hair)
  const c1 = cap(0.182, Math.PI * 0.52)
  c1.rotation.x = -0.35 // 往後蓋，露出臉
  head.add(c1)
  const fringe = mesh(new THREE.SphereGeometry(0.175, 24, 10, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.18, Math.PI * 0.2), hair)
  fringe.rotation.y = Math.PI
  head.add(fringe)
  switch (p.hairStyle) {
    case "spiky":
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2, sp = mesh(new THREE.ConeGeometry(0.045, 0.12, 8), hair, Math.cos(a) * 0.09, 0.15, Math.sin(a) * 0.09 - 0.02)
        sp.rotation.set(Math.sin(a) * 0.6, 0, -Math.cos(a) * 0.6)
        head.add(sp)
      }
      head.add(mesh(new THREE.ConeGeometry(0.05, 0.14, 8), hair, 0, 0.2, -0.02))
      break
    case "curly":
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2
        head.add(mesh(new THREE.SphereGeometry(0.05, 10, 8), hair, Math.cos(a) * 0.15, 0.08 + (i % 2) * 0.03, Math.sin(a) * 0.15 - 0.03))
      }
      head.add(mesh(new THREE.SphereGeometry(0.07, 12, 8), hair, 0, 0.16, -0.02))
      break
    case "twintails":
      for (const s of [-1, 1]) {
        head.add(mesh(new THREE.SphereGeometry(0.06, 14, 10).scale(0.8, 1.6, 0.8), hair, s * 0.2, -0.04, -0.04))
        head.add(mesh(new THREE.SphereGeometry(0.025, 10, 8), accent, s * 0.18, 0.06, -0.03))
      }
      break
    case "bun": {
      // 丸子頭：頭頂兩側各一顆丸子＋大蝴蝶結（和小樂的短髮輪廓明顯不同）
      for (const sx of [-1, 1]) {
        head.add(mesh(new THREE.SphereGeometry(0.07, 16, 12), hair, sx * 0.13, 0.15, -0.04))
        head.add(mesh(new THREE.TorusGeometry(0.072, 0.012, 8, 20), accent, sx * 0.13, 0.15, -0.04))
      }
      for (const sx of [-1, 1]) { const w = mesh(new THREE.ConeGeometry(0.05, 0.08, 12), accent, sx * 0.05, 0.19, 0.06); w.rotation.z = sx * Math.PI / 2; head.add(w) }
      head.add(mesh(new THREE.SphereGeometry(0.022, 10, 8), accent, 0, 0.19, 0.06))
      break
    }
    case "bob":
      head.add(mesh(new THREE.CylinderGeometry(0.19, 0.2, 0.16, 28, 1, true, Math.PI * 0.22, Math.PI * 1.56), hair, 0, -0.04, -0.005))
      break
    default:
      head.add(mesh(new THREE.SphereGeometry(0.06, 12, 8).scale(1.8, 0.45, 0.9), hair, 0.06, 0.13, 0.12)) // 側分瀏海（貼頭，不做頭頂突起）
  }
  g.add(head)
  return {
    group: g,
    animate: (t, moving) => {
      const a = Math.sin(t * 9) * 0.55 * moving
      legs[0].rotation.x = a; legs[1].rotation.x = -a
      arms[0].rotation.x = -a * 0.8; arms[1].rotation.x = a * 0.8
      head.position.y = 0.83 + Math.abs(Math.sin(t * 9)) * 0.012 * moving
      head.rotation.z = moving ? 0 : Math.sin(t * 1.5) * 0.04 // 站著時輕輕晃頭
    },
  }
}

/** 依身高（m）與寬度係數縮放。 */
export function applyBody(group: THREE.Object3D, heightM: number, width: number) {
  group.scale.set(heightM * width, heightM, heightM * Math.sqrt(width))
}
