"use client";

import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import mockFloorplan from "@/data/mockFloorplan.json";

const WALL_HEIGHT = 3;
const WALL_THICKNESS = 0.2;

type Point = [number, number];

interface MockWall {
  start: Point;
  end: Point;
}

const walls = mockFloorplan.walls as MockWall[];

function Wall({ start, end }: MockWall) {
  const dx = end[0] - start[0];
  const dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (length === 0) return null;

  return (
    <mesh
      position={[(start[0] + end[0]) / 2, WALL_HEIGHT / 2, (start[1] + end[1]) / 2]}
      rotation={[0, Math.atan2(-dz, dx), 0]}
    >
      <boxGeometry args={[length + WALL_THICKNESS, WALL_HEIGHT, WALL_THICKNESS]} />
      <meshStandardMaterial color="#f3f0e8" roughness={0.9} />
    </mesh>
  );
}

function Room() {
  const points = walls.flatMap((wall) => [wall.start, wall.end]);
  const minX = Math.min(...points.map((point) => point[0]));
  const maxX = Math.max(...points.map((point) => point[0]));
  const minZ = Math.min(...points.map((point) => point[1]));
  const maxZ = Math.max(...points.map((point) => point[1]));
  const center: Point = [(minX + maxX) / 2, (minZ + maxZ) / 2];

  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[center[0], 0, center[1]]}>
        <planeGeometry args={[maxX - minX, maxZ - minZ]} />
        <meshStandardMaterial color="#d7c4a3" roughness={0.95} />
      </mesh>
      {walls.map((wall, index) => (
        <Wall key={index} start={wall.start} end={wall.end} />
      ))}
      <OrbitControls target={[center[0], WALL_HEIGHT / 3, center[1]]} />
    </>
  );
}

/** 依 mock 牆線的 start、end 拉出固定高度與厚度的方塊牆。 */
export function MockFloorPlan() {
  return (
    <div className="relative h-[70vh] min-h-[28rem] w-full overflow-hidden rounded-xl border bg-[#dfe7ec]">
      <Canvas camera={{ position: [8, 6, 8], fov: 45, near: 0.1, far: 100 }}>
        <color attach="background" args={["#dfe7ec"]} />
        <hemisphereLight args={["#ffffff", "#c8beb0", 1.15]} />
        <ambientLight intensity={0.35} />
        <directionalLight position={[6, 10, 4]} intensity={1.1} />
        <Room />
      </Canvas>
    </div>
  );
}
