"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { Shape } from "three";
import type { MemberId } from "@/components/Character";
import { FixtureMesh } from "@/components/FixtureMeshes";
import {
  FirstPersonControls,
  type ViewMode,
} from "@/components/FirstPersonControls";
import {
  buildSceneGeometry,
  SAMPLE_FLOOR_PLAN,
  type BoxPiece,
  type FloorPiece,
  type SceneGeometry,
} from "@/lib/geometry";
import type { FloorPlan } from "@/lib/parseFloorPlan";

const SCENE_SELECTOR = "[data-floor-plan-scene]";

function WalkStick({
  stick,
}: {
  stick: React.RefObject<{ x: number; y: number }>;
}) {
  const pad = useRef<HTMLDivElement>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const node = pad.current;
    if (!node) return;
    const radius = 42;
    const update = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      const dx = event.clientX - (rect.left + rect.width / 2);
      const dy = event.clientY - (rect.top + rect.height / 2);
      const length = Math.hypot(dx, dy) || 1;
      const scale = Math.min(1, radius / length);
      const x = dx * scale;
      const y = dy * scale;
      stick.current.x = x / radius;
      stick.current.y = -y / radius;
      setKnob({ x, y });
    };
    const end = () => {
      stick.current.x = 0;
      stick.current.y = 0;
      setKnob({ x: 0, y: 0 });
    };
    const start = (event: PointerEvent) => {
      event.stopPropagation();
      event.preventDefault();
      node.setPointerCapture(event.pointerId);
      update(event);
    };
    const move = (event: PointerEvent) => {
      if (!node.hasPointerCapture(event.pointerId)) return;
      event.stopPropagation();
      update(event);
    };
    const stop = (event: PointerEvent) => {
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      end();
    };
    node.addEventListener("pointerdown", start);
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", stop);
    node.addEventListener("pointercancel", stop);
    return () => {
      node.removeEventListener("pointerdown", start);
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", stop);
      node.removeEventListener("pointercancel", stop);
    };
  }, [stick]);

  return (
    <div
      ref={pad}
      className="absolute bottom-4 left-4 size-24 touch-none rounded-full border border-black/10 bg-black/25"
      aria-label="移動搖桿"
    >
      <div
        className="absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-900/80"
        style={{ transform: `translate(calc(-50% + ${knob.x}px), calc(-50% + ${knob.y}px))` }}
      />
    </div>
  );
}

function Boxes({
  pieces,
  children,
}: {
  pieces: BoxPiece[];
  children: React.ReactNode;
}) {
  return pieces.map((piece, index) => (
    <mesh key={index} position={piece.center} rotation={[0, piece.rotationY, 0]}>
      <boxGeometry args={piece.size} />
      {children}
    </mesh>
  ));
}

function RoomFloor({ floor }: { floor: FloorPiece }) {
  const shape = useMemo(() => {
    const next = new Shape();
    floor.points.forEach(([x, z], index) => {
      if (index === 0) next.moveTo(x, -z);
      else next.lineTo(x, -z);
    });
    next.closePath();
    return next;
  }, [floor.points]);

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]}>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color={floor.color} roughness={0.85} />
    </mesh>
  );
}

function Rooms({ geometry }: { geometry: SceneGeometry }) {
  const { bounds, wallHeight } = geometry;
  const width = bounds.maxX - bounds.minX + 2;
  const depth = bounds.maxZ - bounds.minZ + 2;
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[centerX, 0, centerZ]}>
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#bdb7ac" roughness={0.95} />
      </mesh>
      <mesh
        rotation={[Math.PI / 2, 0, 0]}
        position={[centerX, wallHeight, centerZ]}
      >
        <planeGeometry args={[width, depth]} />
        <meshStandardMaterial color="#f7f6f2" roughness={1} />
      </mesh>

      {geometry.floors.map((floor, index) => (
        <RoomFloor key={index} floor={floor} />
      ))}

      <Boxes pieces={geometry.walls}>
        <meshStandardMaterial color="#f1eee7" roughness={0.9} />
      </Boxes>
      <Boxes pieces={geometry.doorLeaves}>
        <meshStandardMaterial color="#9a6b43" roughness={0.7} />
      </Boxes>
      {geometry.fixtures.map((fixture, index) => (
        <FixtureMesh key={index} fixture={fixture} />
      ))}
      <Boxes pieces={geometry.glass}>
        <meshStandardMaterial
          color="#a9d3ea"
          transparent
          opacity={0.3}
          roughness={0.1}
          depthWrite={false}
        />
      </Boxes>
    </>
  );
}

function pointInside(
  x: number,
  z: number,
  points: Array<[number, number]>,
): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, zi] = points[i];
    const [xj, zj] = points[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function MiniMap({
  geometry,
  playerRef,
  className = "h-auto max-h-44 w-44 sm:w-52",
}: {
  geometry: SceneGeometry;
  playerRef: React.RefObject<SVGGElement | null>;
  className?: string;
}) {
  const { bounds } = geometry;
  const pad = 0.5;
  const viewWidth = bounds.maxX - bounds.minX + pad * 2;
  const viewHeight = bounds.maxZ - bounds.minZ + pad * 2;
  const size = Math.max(viewWidth, viewHeight);

  return (
    <svg
      viewBox={`${bounds.minX - pad} ${bounds.minZ - pad} ${viewWidth} ${viewHeight}`}
      className={`rounded-lg border bg-background/85 shadow-sm backdrop-blur ${className}`}
      aria-label="平面小地圖"
    >
      {geometry.floors.map((floor, index) => (
        <polygon
          key={index}
          points={floor.points.map(([x, z]) => `${x},${z}`).join(" ")}
          fill={floor.color}
          opacity={0.75}
        />
      ))}
      {geometry.wallColliders.map((collider, index) => (
        <line
          key={index}
          x1={collider.a[0]}
          y1={collider.a[1]}
          x2={collider.b[0]}
          y2={collider.b[1]}
          stroke="#3f3a33"
          strokeWidth={Math.max(collider.radius * 2, size * 0.008)}
          strokeLinecap="square"
        />
      ))}
      {geometry.fixtures.map((fixture, index) => (
        <rect
          key={index}
          x={-fixture.width / 2}
          y={-fixture.depth / 2}
          width={fixture.width}
          height={fixture.depth}
          transform={`translate(${fixture.position[0]} ${fixture.position[1]}) rotate(${(fixture.rotationY * 180) / Math.PI})`}
          fill={fixture.inferred ? "#5c6b73" : "#24343a"}
          opacity={0.8}
        />
      ))}
      {geometry.glass.map((piece, index) => {
        const half = piece.size[0] / 2;
        const dx = Math.cos(piece.rotationY) * half;
        const dz = -Math.sin(piece.rotationY) * half;
        return (
          <line
            key={`window-${index}`}
            x1={piece.center[0] - dx}
            y1={piece.center[2] - dz}
            x2={piece.center[0] + dx}
            y2={piece.center[2] + dz}
            stroke="#2f6fad"
            strokeWidth={Math.max(size * 0.012, 0.04)}
            strokeLinecap="round"
          />
        );
      })}
      {geometry.doorSwings.map((door, index) => {
        const closedX = door.hinge[0] + door.along[0] * door.width;
        const closedZ = door.hinge[1] + door.along[1] * door.width;
        const openX = door.hinge[0] + door.open[0] * door.width;
        const openZ = door.hinge[1] + door.open[1] * door.width;
        const cross = door.along[0] * door.open[1] - door.along[1] * door.open[0];
        const sweep = cross > 0 ? 1 : 0;
        return (
          <g key={`door-${index}`} fill="none" stroke="#c4523a" strokeWidth={Math.max(size * 0.008, 0.025)}>
            <line x1={door.hinge[0]} y1={door.hinge[1]} x2={closedX} y2={closedZ} />
            <path
              d={`M ${closedX} ${closedZ} A ${door.width} ${door.width} 0 0 ${sweep} ${openX} ${openZ}`}
            />
          </g>
        );
      })}
      {geometry.floors.map((floor, index) => (
        <text
          key={index}
          x={floor.labelAt[0]}
          y={floor.labelAt[1]}
          fontSize={size * 0.055}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="#2d2a26"
        >
          {floor.name}
        </text>
      ))}
      <g ref={playerRef}>
        <circle r={size * 0.022} fill="#0f766e" />
        <path
          d={`M ${size * 0.05} 0 L ${-size * 0.012} ${size * 0.025} L ${-size * 0.012} ${-size * 0.025} Z`}
          fill="#0f766e"
        />
      </g>
    </svg>
  );
}

type Scene3DProps = {
  plan: FloorPlan | null;
  viewMode: ViewMode;
  member: MemberId;
  /** 人物身高（公尺） */
  heightM: number;
  /** 使用者輸入的室內坪數，沒有時用模型比例尺 */
  ping: number | null;
  onGeometry?: (geometry: SceneGeometry) => void;
  /** 右側平面圖共用的人物標記 */
  playerRef?: React.RefObject<SVGGElement | null>;
  showMiniMap?: boolean;
  /** 填滿父層高度 */
  fill?: boolean;
  onLocate?: (roomName: string) => void;
};

export function Scene3D({
  plan,
  viewMode,
  member,
  heightM,
  ping,
  onGeometry,
  playerRef: playerRefProp,
  showMiniMap = true,
  fill = false,
  onLocate,
}: Scene3DProps) {
  const localPlayerRef = useRef<SVGGElement>(null);
  const playerRef = playerRefProp ?? localPlayerRef;
  const roomName = useRef("");
  const stick = useRef({ x: 0, y: 0 });
  const geometry = useMemo(
    () => buildSceneGeometry(plan ?? SAMPLE_FLOOR_PLAN, { ping }),
    [plan, ping],
  );

  useEffect(() => {
    onGeometry?.(geometry);
  }, [geometry, onGeometry]);
  const empty = plan !== null && geometry.walls.length === 0;

  const handleMove = useCallback(
    (x: number, z: number, headingX: number, headingZ: number) => {
      const angle = (Math.atan2(headingZ, headingX) * 180) / Math.PI;
      playerRef.current?.setAttribute(
        "transform",
        `translate(${x} ${z}) rotate(${angle})`,
      );
      const name =
        geometry.floors.find((floor) => pointInside(x, z, floor.points))?.name ??
        "走道";
      if (name !== roomName.current) {
        roomName.current = name;
        onLocate?.(name);
      }
    },
    [geometry.floors, onLocate, playerRef],
  );

  return (
    <div
      data-floor-plan-scene
      className={`relative w-full cursor-grab overflow-hidden rounded-xl border bg-[#dfe7ec] active:cursor-grabbing ${
        fill ? "h-full min-h-0" : "h-[70vh] min-h-[28rem]"
      }`}
    >
      <Canvas camera={{ fov: 62, near: 0.05, far: 200 }} dpr={[1, 2]}>
        <color attach="background" args={["#dfe7ec"]} />
        <hemisphereLight args={["#ffffff", "#b8ad9c", 1.1]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[6, 12, 4]} intensity={0.9} />
        <pointLight
          position={[geometry.spawn[0], geometry.wallHeight - 0.3, geometry.spawn[1]]}
          intensity={6}
          distance={12}
        />
        <Rooms geometry={geometry} />
        <FirstPersonControls
          viewMode={viewMode}
          member={member}
          heightM={heightM}
          wallHeight={geometry.wallHeight}
          colliders={geometry.colliders}
          wallColliders={geometry.wallColliders}
          spawn={geometry.spawn}
          lookAt={geometry.lookAt}
          selector={SCENE_SELECTOR}
          stick={stick}
          onMove={handleMove}
        />
      </Canvas>
      <button
        type="button"
        aria-label="拖曳環顧四周"
        tabIndex={-1}
        className="absolute inset-0 cursor-grab outline-none active:cursor-grabbing"
      />
      <WalkStick stick={stick} />

      <div className="pointer-events-none absolute left-3 top-3 flex flex-wrap gap-2">
        <span className="rounded-md bg-background/85 px-2 py-1 text-xs font-medium shadow-sm backdrop-blur">
          {plan ? "辨識格局" : "示範格局"}
        </span>
        <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
          {geometry.scaleSource === "ping"
            ? `依 ${geometry.ping.toFixed(1)} 坪校正比例`
            : geometry.scaleSource === "estimated"
              ? `比例尺不合理，已估算約 ${geometry.ping.toFixed(1)} 坪`
              : `約 ${geometry.ping.toFixed(1)} 坪`}
        </span>
        {geometry.inferredFixtures > 0 ? (
          <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            圖上沒標的傢俱與衛浴已依房間補上
          </span>
        ) : null}
        {geometry.unmatchedOpenings > 0 ? (
          <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
            {geometry.unmatchedOpenings} 個門窗沒有對到牆
          </span>
        ) : null}
      </div>

      {showMiniMap ? (
        <div className="pointer-events-none absolute bottom-3 left-3">
          <MiniMap geometry={geometry} playerRef={playerRef} />
        </div>
      ) : null}

      <p className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-background/85 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur">
        {empty
          ? "沒有辨識到牆，可以換一張更清楚的平面圖。"
          : "拖曳畫面環顧，WASD 或方向鍵移動，Shift 加速"}
      </p>
    </div>
  );
}
