"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  Character,
  type CharacterHandle,
  type MemberId,
} from "@/components/Character";
import { hitsCollider, type Collider } from "@/lib/geometry";

export type ViewMode = "first" | "third";

const MOUSE_SENSITIVITY = 0.0022;

const MOVE_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ShiftLeft",
  "ShiftRight",
]);

type FirstPersonControlsProps = {
  viewMode: ViewMode;
  member: MemberId;
  /** 人物身高（公尺） */
  heightM: number;
  wallHeight: number;
  colliders: Collider[];
  /** 第三人稱鏡頭避免穿牆用 */
  wallColliders: Collider[];
  spawn: [number, number];
  lookAt: [number, number];
  /** 拖曳環顧的畫布容器 */
  selector: string;
  /** 左下角搖桿，x 右、y 前，各約 -1 到 1 */
  stick?: React.RefObject<{ x: number; y: number }>;
  onMove?: (x: number, z: number, headingX: number, headingZ: number) => void;
};

function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function shortestAngle(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export function FirstPersonControls({
  viewMode,
  member,
  heightM,
  wallHeight,
  colliders,
  wallColliders,
  spawn,
  lookAt,
  selector,
  stick,
  onMove,
}: FirstPersonControlsProps) {
  const gl = useThree((state) => state.gl);
  const character = useRef<CharacterHandle>(null);
  const keys = useRef(new Set<string>());
  const player = useRef({ x: 0, z: 0, yaw: 0, pitch: 0, facing: 0, stride: 0, swing: 0 });
  const dragging = useRef(false);

  useEffect(() => {
    const dx = lookAt[0] - spawn[0];
    const dz = lookAt[1] - spawn[1];
    const yaw = Math.atan2(-dx, -dz);
    player.current = {
      x: spawn[0],
      z: spawn[1],
      yaw,
      pitch: 0,
      facing: yaw + Math.PI,
      stride: 0,
      swing: 0,
    };
  }, [spawn, lookAt]);

  useEffect(() => {
    const canvas = gl.domElement;
    const root = (canvas.closest(selector) as HTMLElement | null) ?? canvas;
    let lastX = 0;
    let lastY = 0;
    const look = (event: PointerEvent) => {
      if (!dragging.current) return;
      const dx = event.movementX || event.clientX - lastX;
      const dy = event.movementY || event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      const state = player.current;
      state.yaw -= dx * MOUSE_SENSITIVITY;
      state.pitch = Math.max(
        -1.35,
        Math.min(1.35, state.pitch - dy * MOUSE_SENSITIVITY),
      );
    };
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      dragging.current = true;
      lastX = event.clientX;
      lastY = event.clientY;
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        // 指標已結束時不抓取，拖曳仍用畫面上的移動量
      }
    };
    const pointerUp = (event: PointerEvent) => {
      dragging.current = false;
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };
    const handleDown = (event: KeyboardEvent) => {
      if (isTyping(event) || !MOVE_KEYS.has(event.code)) return;
      event.preventDefault();
      keys.current.add(event.code);
    };
    const handleUp = (event: KeyboardEvent) => keys.current.delete(event.code);
    const clear = () => keys.current.clear();

    root.addEventListener("pointerdown", pointerDown);
    root.addEventListener("pointermove", look);
    root.addEventListener("pointerup", pointerUp);
    root.addEventListener("pointercancel", pointerUp);
    window.addEventListener("keydown", handleDown);
    window.addEventListener("keyup", handleUp);
    window.addEventListener("blur", clear);
    return () => {
      root.removeEventListener("pointerdown", pointerDown);
      root.removeEventListener("pointermove", look);
      root.removeEventListener("pointerup", pointerUp);
      root.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("keydown", handleDown);
      window.removeEventListener("keyup", handleUp);
      window.removeEventListener("blur", clear);
    };
  }, [gl, selector]);

  useFrame(({ camera }, delta) => {
    const dt = Math.min(delta, 0.05);
    const state = player.current;
    const pressed = keys.current;
    const radius = 0.24 * (heightM / 1.75);
    const eye = heightM * 0.935;

    const forwardX = -Math.sin(state.yaw);
    const forwardZ = -Math.cos(state.yaw);
    const rightX = Math.cos(state.yaw);
    const rightZ = -Math.sin(state.yaw);

    const stickX = stick?.current?.x ?? 0;
    const stickY = stick?.current?.y ?? 0;
    let moving = false;
    if (pressed.size > 0 || Math.hypot(stickX, stickY) > 0.08) {
      const ahead =
        Number(pressed.has("KeyW") || pressed.has("ArrowUp")) -
        Number(pressed.has("KeyS") || pressed.has("ArrowDown")) +
        stickY;
      const side =
        Number(pressed.has("KeyD") || pressed.has("ArrowRight")) -
        Number(pressed.has("KeyA") || pressed.has("ArrowLeft")) +
        stickX;
      let moveX = forwardX * ahead + rightX * side;
      let moveZ = forwardZ * ahead + rightZ * side;
      const length = Math.hypot(moveX, moveZ);

      if (length > 0) {
        moving = true;
        const run = pressed.has("ShiftLeft") || pressed.has("ShiftRight");
        const speed = (run ? 3.2 : 1.5) * (heightM / 1.75);
        const step = (speed * dt) / length;
        moveX *= step;
        moveZ *= step;

        const stuck = hitsCollider([state.x, state.z], colliders, radius);
        const canStand = (nx: number, nz: number) =>
          stuck || !hitsCollider([nx, nz], colliders, radius);
        if (canStand(state.x + moveX, state.z)) state.x += moveX;
        if (canStand(state.x, state.z + moveZ)) state.z += moveZ;

        state.facing += shortestAngle(state.facing, Math.atan2(moveX, moveZ)) * Math.min(1, dt * 12);
        state.stride += dt * speed * 4.2;
      }
    }

    state.swing += ((moving ? Math.sin(state.stride) : 0) - state.swing) * Math.min(1, dt * 10);
    character.current?.setStride(state.swing);

    const root = character.current?.root;
    if (root) {
      root.visible = viewMode === "third";
      root.position.set(state.x, 0, state.z);
      root.rotation.y = state.facing;
    }

    if (viewMode === "first") {
      camera.rotation.order = "YXZ";
      camera.position.set(state.x, eye, state.z);
      camera.rotation.set(state.pitch, state.yaw, 0);
      onMove?.(state.x, state.z, forwardX, forwardZ);
      return;
    }

    const pitch = Math.max(-1.1, Math.min(0.55, state.pitch));
    const pivotY = heightM * 0.9;
    const lookX = forwardX * Math.cos(pitch);
    const lookZ = forwardZ * Math.cos(pitch);
    const lookY = Math.sin(pitch);
    const desired = Math.max(1.6, heightM * 1.35);

    let distance = desired;
    for (let t = 0.2; t <= desired; t += 0.05) {
      if (
        hitsCollider(
          [state.x - lookX * t + rightX * 0.3 * (t / desired), state.z - lookZ * t + rightZ * 0.3 * (t / desired)],
          wallColliders,
          0.18,
        )
      ) {
        distance = Math.max(0.35, t - 0.2);
        break;
      }
    }

    const shoulder = 0.3 * (distance / desired);
    const camX = state.x - lookX * distance + rightX * shoulder;
    const camZ = state.z - lookZ * distance + rightZ * shoulder;
    const camY = Math.max(0.3, Math.min(wallHeight - 0.15, pivotY - lookY * distance + 0.25));

    camera.rotation.order = "YXZ";
    camera.position.set(camX, camY, camZ);
    camera.lookAt(
      state.x + lookX * 2 + rightX * shoulder,
      pivotY + lookY * 2,
      state.z + lookZ * 2 + rightZ * shoulder,
    );
    onMove?.(state.x, state.z, Math.sin(state.facing), Math.cos(state.facing));
  });

  return <Character ref={character} member={member} heightM={heightM} />;
}
