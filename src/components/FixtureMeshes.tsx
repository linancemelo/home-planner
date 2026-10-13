"use client";

import { RoundedBox } from "@react-three/drei";
import type { SceneFixture } from "@/lib/geometry";

type V3 = [number, number, number];

type Finish =
  | "fabric"
  | "wood"
  | "darkWood"
  | "ceramic"
  | "chrome"
  | "stone"
  | "glass"
  | "mirror"
  | "screen"
  | "lacquer"
  | "rubber";

function FinishMaterial({ finish, color }: { finish: Finish; color: string }) {
  switch (finish) {
    case "fabric":
      return <meshStandardMaterial color={color} roughness={0.95} metalness={0} />;
    case "wood":
    case "darkWood":
      return <meshStandardMaterial color={color} roughness={0.6} metalness={0.02} />;
    case "ceramic":
      return <meshPhysicalMaterial color={color} roughness={0.12} clearcoat={1} clearcoatRoughness={0.08} />;
    case "chrome":
      return <meshStandardMaterial color={color} roughness={0.18} metalness={0.95} />;
    case "stone":
      return <meshPhysicalMaterial color={color} roughness={0.35} clearcoat={0.4} />;
    case "glass":
      return (
        <meshPhysicalMaterial
          color={color}
          roughness={0.05}
          transmission={0.9}
          transparent
          opacity={0.3}
          depthWrite={false}
        />
      );
    case "mirror":
      return <meshStandardMaterial color={color} roughness={0.02} metalness={1} />;
    case "screen":
      return <meshStandardMaterial color={color} roughness={0.25} metalness={0.3} emissive="#0b1b2a" emissiveIntensity={0.4} />;
    case "lacquer":
      return <meshStandardMaterial color={color} roughness={0.35} metalness={0.05} />;
    case "rubber":
      return <meshStandardMaterial color={color} roughness={0.9} />;
  }
}

function Box({
  position,
  size,
  color,
  finish = "lacquer",
  radius = 0,
  rotation,
}: {
  position: V3;
  size: V3;
  color: string;
  finish?: Finish;
  radius?: number;
  rotation?: V3;
}) {
  if (radius > 0) {
    const r = Math.min(radius, size[0] / 2, size[1] / 2, size[2] / 2) * 0.999;
    return (
      <RoundedBox args={size} radius={r} smoothness={3} position={position} rotation={rotation}>
        <FinishMaterial finish={finish} color={color} />
      </RoundedBox>
    );
  }
  return (
    <mesh position={position} rotation={rotation}>
      <boxGeometry args={size} />
      <FinishMaterial finish={finish} color={color} />
    </mesh>
  );
}

function Cylinder({
  position,
  radiusTop,
  radiusBottom = radiusTop,
  height,
  color,
  finish = "lacquer",
  rotation,
  segments = 24,
}: {
  position: V3;
  radiusTop: number;
  radiusBottom?: number;
  height: number;
  color: string;
  finish?: Finish;
  rotation?: V3;
  segments?: number;
}) {
  return (
    <mesh position={position} rotation={rotation}>
      <cylinderGeometry args={[radiusTop, radiusBottom, height, segments]} />
      <FinishMaterial finish={finish} color={color} />
    </mesh>
  );
}

function Legs({
  width,
  depth,
  height,
  inset = 0.06,
  radius = 0.02,
  color = "#5b4632",
  finish = "darkWood",
}: {
  width: number;
  depth: number;
  height: number;
  inset?: number;
  radius?: number;
  color?: string;
  finish?: Finish;
}) {
  const x = width / 2 - inset;
  const z = depth / 2 - inset;
  return (
    <>
      {(
        [
          [-x, -z],
          [x, -z],
          [-x, z],
          [x, z],
        ] as const
      ).map(([lx, lz], index) => (
        <Cylinder
          key={index}
          position={[lx, height / 2, lz]}
          radiusTop={radius}
          radiusBottom={radius * 0.8}
          height={height}
          color={color}
          finish={finish}
          segments={12}
        />
      ))}
    </>
  );
}

function Bed({ width, depth }: { width: number; depth: number }) {
  const frameTop = 0.32;
  const mattress = 0.22;
  const top = frameTop + mattress;
  const pillowWidth = Math.min(0.7, width / 2 - 0.08);
  return (
    <group>
      <Box position={[0, 0.2, 0.02]} size={[width, 0.24, depth - 0.04]} color="#a88563" finish="wood" radius={0.02} />
      <Legs width={width} depth={depth - 0.04} height={0.08} inset={0.08} radius={0.025} />
      <Box position={[0, frameTop + mattress / 2, 0.04]} size={[width - 0.06, mattress, depth - 0.14]} color="#f5f2ec" finish="fabric" radius={0.07} />
      <Box position={[0, top + 0.02, depth * 0.16]} size={[width - 0.02, 0.07, depth * 0.62]} color="#8fa7b8" finish="fabric" radius={0.03} />
      <Box position={[0, top + 0.035, depth * 0.44]} size={[width + 0.02, 0.05, 0.3]} color="#7c93a4" finish="fabric" radius={0.02} />
      <Box position={[-width / 4, top + 0.07, -depth / 2 + 0.3]} size={[pillowWidth, 0.13, 0.36]} color="#fbfaf7" finish="fabric" radius={0.06} />
      <Box position={[width / 4, top + 0.07, -depth / 2 + 0.3]} size={[pillowWidth, 0.13, 0.36]} color="#fbfaf7" finish="fabric" radius={0.06} />
      <Box position={[0, 0.56, -depth / 2 + 0.05]} size={[width + 0.06, 0.95, 0.1]} color="#cdbba3" finish="fabric" radius={0.04} />
    </group>
  );
}

function Sofa({ width, depth }: { width: number; depth: number }) {
  const arm = 0.16;
  const seats = width > 1.6 ? 3 : 2;
  const seatWidth = (width - arm * 2) / seats;
  const fabric = "#7a8a7e";
  const cushion = "#8a9a8e";
  return (
    <group>
      <Box position={[0, 0.2, 0]} size={[width, 0.26, depth]} color={fabric} finish="fabric" radius={0.04} />
      <Legs width={width} depth={depth} height={0.08} inset={0.08} radius={0.018} color="#3d3025" />
      {Array.from({ length: seats }, (_, index) => (
        <Box
          key={`seat-${index}`}
          position={[-width / 2 + arm + seatWidth * (index + 0.5), 0.4, 0.08]}
          size={[seatWidth - 0.02, 0.14, depth - 0.3]}
          color={cushion}
          finish="fabric"
          radius={0.05}
        />
      ))}
      {Array.from({ length: seats }, (_, index) => (
        <Box
          key={`back-${index}`}
          position={[-width / 2 + arm + seatWidth * (index + 0.5), 0.62, -depth / 2 + 0.17]}
          size={[seatWidth - 0.02, 0.42, 0.18]}
          color={cushion}
          finish="fabric"
          radius={0.07}
          rotation={[-0.12, 0, 0]}
        />
      ))}
      <Box position={[0, 0.5, -depth / 2 + 0.07]} size={[width, 0.5, 0.14]} color={fabric} finish="fabric" radius={0.05} />
      <Box position={[-width / 2 + arm / 2, 0.44, 0]} size={[arm, 0.36, depth]} color={fabric} finish="fabric" radius={0.06} />
      <Box position={[width / 2 - arm / 2, 0.44, 0]} size={[arm, 0.36, depth]} color={fabric} finish="fabric" radius={0.06} />
      <Box position={[-width / 2 + arm + 0.22, 0.58, -depth / 2 + 0.34]} size={[0.38, 0.34, 0.12]} color="#d8b77f" finish="fabric" radius={0.06} rotation={[-0.2, 0.2, 0]} />
    </group>
  );
}

function Chair({ position, rotationY }: { position: V3; rotationY: number }) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <Box position={[0, 0.45, 0]} size={[0.44, 0.05, 0.44]} color="#a07a55" finish="wood" radius={0.015} />
      <Legs width={0.44} depth={0.44} height={0.43} inset={0.04} radius={0.016} />
      <Box position={[0, 0.72, -0.2]} size={[0.42, 0.34, 0.04]} color="#a07a55" finish="wood" radius={0.015} />
    </group>
  );
}

function DiningTable({ width, depth }: { width: number; depth: number }) {
  const height = 0.75;
  const perSide = width >= 1.3 ? 2 : 1;
  const chairs: { position: V3; rotationY: number }[] = [];
  for (let i = 0; i < perSide; i += 1) {
    const x = perSide === 1 ? 0 : (i === 0 ? -1 : 1) * width * 0.24;
    chairs.push({ position: [x, 0, depth / 2 + 0.18], rotationY: Math.PI });
    chairs.push({ position: [x, 0, -depth / 2 - 0.18], rotationY: 0 });
  }
  return (
    <group>
      <Box position={[0, height - 0.02, 0]} size={[width, 0.04, depth]} color="#b48a60" finish="wood" radius={0.012} />
      <Legs width={width} depth={depth} height={height - 0.04} inset={0.07} radius={0.025} />
      {chairs.map((chair, index) => (
        <Chair key={index} position={chair.position} rotationY={chair.rotationY} />
      ))}
      <Cylinder position={[0, height + 0.06, 0]} radiusTop={0.06} radiusBottom={0.04} height={0.12} color="#e8e3d8" finish="ceramic" />
    </group>
  );
}

function Desk({ width, depth }: { width: number; depth: number }) {
  return (
    <group>
      <Box position={[0, 0.73, 0]} size={[width, 0.03, depth]} color="#c9b08a" finish="wood" radius={0.008} />
      <Legs width={width} depth={depth} height={0.72} inset={0.04} radius={0.015} color="#2f3134" finish="chrome" />
      <Box position={[0, 1.02, -depth / 2 + 0.12]} size={[0.56, 0.34, 0.025]} color="#1b1d20" finish="screen" radius={0.01} />
      <Cylinder position={[0, 0.82, -depth / 2 + 0.14]} radiusTop={0.015} height={0.16} color="#3a3c40" finish="chrome" />
      <Box position={[0, 0.755, 0.06]} size={[0.42, 0.015, 0.14]} color="#2b2d31" radius={0.004} />
      <Chair position={[0, 0, depth / 2 + 0.28]} rotationY={Math.PI} />
    </group>
  );
}

function Wardrobe({ width, depth }: { width: number; depth: number }) {
  const height = 2.1;
  const doors = width > 1.1 ? 2 : 1;
  const doorWidth = width / doors;
  return (
    <group>
      <Box position={[0, height / 2 + 0.04, 0]} size={[width, height, depth]} color="#e9e4da" finish="lacquer" radius={0.01} />
      <Box position={[0, 0.02, 0]} size={[width - 0.04, 0.04, depth - 0.04]} color="#bdb6aa" />
      {Array.from({ length: doors }, (_, index) => {
        const x = -width / 2 + doorWidth * (index + 0.5);
        return (
          <group key={index}>
            <Box position={[x, height / 2 + 0.04, depth / 2 + 0.005]} size={[doorWidth - 0.012, height - 0.02, 0.018]} color="#f1ece3" finish="lacquer" radius={0.004} />
            <Box
              position={[x + (index === 0 && doors === 2 ? doorWidth / 2 - 0.06 : -doorWidth / 2 + 0.06), 1.05, depth / 2 + 0.025]}
              size={[0.018, 0.34, 0.018]}
              color="#b8b3aa"
              finish="chrome"
            />
          </group>
        );
      })}
    </group>
  );
}

function Television({ width, depth }: { width: number; depth: number }) {
  const screenWidth = Math.min(1.45, width * 0.85);
  return (
    <group>
      <Box position={[0, 0.24, 0]} size={[width, 0.4, depth]} color="#6b5440" finish="wood" radius={0.015} />
      <Box position={[-width / 4, 0.24, depth / 2 + 0.003]} size={[width / 2 - 0.02, 0.36, 0.01]} color="#5b4535" finish="wood" />
      <Box position={[width / 4, 0.24, depth / 2 + 0.003]} size={[width / 2 - 0.02, 0.36, 0.01]} color="#5b4535" finish="wood" />
      <Legs width={width} depth={depth} height={0.04} inset={0.05} radius={0.02} color="#2a2a2a" finish="chrome" />
      <Box position={[0, 0.48, -depth / 2 + 0.12]} size={[0.3, 0.02, 0.18]} color="#222428" finish="chrome" />
      <Cylinder position={[0, 0.54, -depth / 2 + 0.12]} radiusTop={0.02} height={0.1} color="#222428" finish="chrome" />
      <Box position={[0, 0.9, -depth / 2 + 0.12]} size={[screenWidth, screenWidth * 0.57, 0.035]} color="#111316" finish="lacquer" radius={0.008} />
      <Box position={[0, 0.9, -depth / 2 + 0.14]} size={[screenWidth - 0.03, screenWidth * 0.57 - 0.03, 0.004]} color="#16283a" finish="screen" />
      <Cylinder position={[width / 2 - 0.2, 0.55, 0]} radiusTop={0.08} radiusBottom={0.06} height={0.22} color="#ddd6c8" finish="ceramic" />
    </group>
  );
}

function Toilet({ depth }: { depth: number }) {
  const back = -depth / 2;
  return (
    <group>
      <Cylinder position={[0, 0.18, 0.02]} radiusTop={0.17} radiusBottom={0.13} height={0.36} color="#fbfcfc" finish="ceramic" />
      <mesh position={[0, 0.36, 0.08]} scale={[1, 0.35, 1.25]}>
        <sphereGeometry args={[0.19, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <FinishMaterial finish="ceramic" color="#fbfcfc" />
      </mesh>
      <mesh position={[0, 0.405, 0.08]} rotation={[Math.PI / 2, 0, 0]} scale={[1, 1.25, 1]}>
        <torusGeometry args={[0.15, 0.025, 12, 32]} />
        <FinishMaterial finish="ceramic" color="#ffffff" />
      </mesh>
      <Box position={[0, 0.58, back + 0.1]} size={[0.38, 0.36, 0.18]} color="#fbfcfc" finish="ceramic" radius={0.04} />
      <Box position={[0, 0.775, back + 0.1]} size={[0.4, 0.03, 0.2]} color="#ffffff" finish="ceramic" radius={0.012} />
      <Cylinder position={[0.1, 0.8, back + 0.1]} radiusTop={0.018} height={0.02} color="#c9ced2" finish="chrome" />
    </group>
  );
}

function Faucet({ position }: { position: V3 }) {
  return (
    <group position={position}>
      <Cylinder position={[0, 0.07, 0]} radiusTop={0.016} height={0.14} color="#d9dde0" finish="chrome" />
      <Cylinder position={[0, 0.14, 0.05]} radiusTop={0.012} height={0.11} color="#d9dde0" finish="chrome" rotation={[Math.PI / 2, 0, 0]} />
      <Box position={[0, 0.16, -0.03]} size={[0.02, 0.02, 0.07]} color="#d9dde0" finish="chrome" rotation={[0.5, 0, 0]} />
    </group>
  );
}

function Sink({
  width,
  depth,
  roomType,
}: {
  width: number;
  depth: number;
  roomType: string;
}) {
  const kitchen = roomType === "kitchen";
  const height = kitchen ? 0.88 : 0.82;
  return (
    <group>
      <Box position={[0, height / 2 - 0.02, 0]} size={[width, height - 0.04, depth]} color={kitchen ? "#e3ddd2" : "#8d6e52"} finish={kitchen ? "lacquer" : "wood"} radius={0.01} />
      <Box position={[0, height / 2 - 0.05, depth / 2 + 0.005]} size={[width - 0.03, height - 0.14, 0.012]} color={kitchen ? "#ece7dd" : "#9b7b5d"} finish={kitchen ? "lacquer" : "wood"} />
      <Box position={[0, height, 0]} size={[width, 0.04, depth]} color={kitchen ? "#cfc9bf" : "#f7f8f8"} finish={kitchen ? "stone" : "ceramic"} radius={0.012} />
      <Box position={[0, height + 0.005, 0.03]} size={[width * 0.62, 0.03, depth * 0.58]} color={kitchen ? "#b9bec2" : "#e9eef0"} finish={kitchen ? "chrome" : "ceramic"} radius={0.03} />
      <Faucet position={[0, height + 0.02, -depth / 2 + 0.07]} />
      {kitchen ? null : (
        <>
          <Box position={[0, 1.5, -depth / 2 + 0.015]} size={[width * 0.9, 0.7, 0.02]} color="#dfe6ea" finish="mirror" radius={0.02} />
          <Box position={[0, 1.9, -depth / 2 + 0.04]} size={[width * 0.6, 0.04, 0.05]} color="#f3efe5" finish="lacquer" />
        </>
      )}
    </group>
  );
}

function Bathtub({ width, depth }: { width: number; depth: number }) {
  return (
    <group>
      <Box position={[0, 0.28, 0]} size={[width, 0.56, depth]} color="#fbfcfc" finish="ceramic" radius={0.06} />
      <Box position={[0, 0.4, 0.02]} size={[width - 0.14, 0.34, depth - 0.14]} color="#e9f0f2" finish="ceramic" radius={0.1} />
      <Box position={[0, 0.4, 0.02]} size={[width - 0.2, 0.18, depth - 0.2]} color="#9fd0e3" finish="glass" radius={0.06} />
      <Faucet position={[-width / 2 + 0.12, 0.56, -depth / 2 + 0.06]} />
    </group>
  );
}

function Shower({ width, depth }: { width: number; depth: number }) {
  return (
    <group>
      <Box position={[0, 0.03, 0]} size={[width, 0.06, depth]} color="#eef2f3" finish="ceramic" radius={0.02} />
      <Cylinder position={[0, 0.062, 0]} radiusTop={0.04} height={0.005} color="#b8bfc3" finish="chrome" />
      <Box position={[0, 1.05, depth / 2 - 0.01]} size={[width, 2, 0.012]} color="#cfe6f0" finish="glass" />
      <Box position={[width / 2 - 0.01, 1.05, 0]} size={[0.012, 2, depth]} color="#cfe6f0" finish="glass" />
      <Box position={[width / 2 - 0.01, 2.05, depth / 2 - 0.01]} size={[0.02, 0.02, 0.02]} color="#c7ccd0" finish="chrome" />
      <Cylinder position={[-width / 2 + 0.1, 1.2, -depth / 2 + 0.05]} radiusTop={0.012} height={1.1} color="#d9dde0" finish="chrome" />
      <Cylinder position={[-width / 2 + 0.2, 1.95, -depth / 2 + 0.2]} radiusTop={0.1} radiusBottom={0.1} height={0.02} color="#d9dde0" finish="chrome" />
      <Box position={[-width / 2 + 0.15, 1.8, -depth / 2 + 0.12]} size={[0.02, 0.02, 0.2]} color="#d9dde0" finish="chrome" rotation={[0.6, 0, 0]} />
    </group>
  );
}

function Stove({ width, depth }: { width: number; depth: number }) {
  const height = 0.88;
  const burners: [number, number][] = [
    [-width * 0.22, -depth * 0.18],
    [width * 0.22, -depth * 0.18],
    [-width * 0.22, depth * 0.18],
    [width * 0.22, depth * 0.18],
  ];
  return (
    <group>
      <Box position={[0, height / 2 - 0.02, 0]} size={[width, height - 0.04, depth]} color="#e3ddd2" finish="lacquer" radius={0.01} />
      <Box position={[0, height / 2 - 0.08, depth / 2 + 0.006]} size={[width - 0.06, 0.42, 0.012]} color="#2b2e32" finish="glass" />
      <Box position={[0, height, 0]} size={[width, 0.03, depth]} color="#17191c" finish="screen" radius={0.008} />
      {burners.map(([x, z], index) => (
        <mesh key={index} position={[x, height + 0.018, z]} rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[0.07, 0.008, 8, 28]} />
          <FinishMaterial finish="chrome" color="#5a5f64" />
        </mesh>
      ))}
      <Box position={[0, 1.72, -depth / 2 + 0.25]} size={[width + 0.1, 0.12, 0.5]} color="#c3c8cc" finish="chrome" radius={0.01} />
      <Box position={[0, 2.1, -depth / 2 + 0.14]} size={[0.28, 0.66, 0.22]} color="#c3c8cc" finish="chrome" />
    </group>
  );
}

function Counter({ width, depth }: { width: number; depth: number }) {
  const height = 0.88;
  const doors = Math.max(1, Math.round(width / 0.6));
  const doorWidth = width / doors;
  return (
    <group>
      <Box position={[0, 0.05, 0.02]} size={[width - 0.02, 0.1, depth - 0.08]} color="#3b3b3b" />
      <Box position={[0, height / 2 + 0.03, 0]} size={[width, height - 0.1, depth - 0.02]} color="#e3ddd2" finish="lacquer" />
      {Array.from({ length: doors }, (_, index) => (
        <group key={index}>
          <Box position={[-width / 2 + doorWidth * (index + 0.5), height / 2 + 0.03, depth / 2 + 0.002]} size={[doorWidth - 0.008, height - 0.12, 0.016]} color="#ede8df" finish="lacquer" radius={0.003} />
          <Box position={[-width / 2 + doorWidth * (index + 0.5), height - 0.12, depth / 2 + 0.018]} size={[0.14, 0.012, 0.012]} color="#a9adb0" finish="chrome" />
        </group>
      ))}
      <Box position={[0, height, 0.01]} size={[width + 0.02, 0.04, depth + 0.02]} color="#d9d3c8" finish="stone" radius={0.008} />
      <Box position={[0, height + 0.3, -depth / 2 + 0.01]} size={[width, 0.56, 0.015]} color="#eef0ee" finish="ceramic" />
      <Box position={[0, 1.85, -depth / 2 + 0.18]} size={[width, 0.7, 0.34]} color="#ede8df" finish="lacquer" radius={0.006} />
    </group>
  );
}

function Washer({ width, depth }: { width: number; depth: number }) {
  return (
    <group>
      <Box position={[0, 0.43, 0]} size={[width, 0.84, depth]} color="#f3f5f6" finish="lacquer" radius={0.03} />
      <Box position={[0, 0.78, depth / 2 - 0.02]} size={[width - 0.06, 0.08, 0.04]} color="#dfe3e6" finish="lacquer" radius={0.01} />
      <Cylinder position={[width * 0.28, 0.78, depth / 2 + 0.005]} radiusTop={0.025} height={0.02} color="#9aa2a8" finish="chrome" rotation={[Math.PI / 2, 0, 0]} />
      <mesh position={[0, 0.4, depth / 2 + 0.005]}>
        <torusGeometry args={[0.17, 0.025, 12, 36]} />
        <FinishMaterial finish="chrome" color="#c3c9cd" />
      </mesh>
      <Cylinder position={[0, 0.4, depth / 2 + 0.005]} radiusTop={0.16} height={0.01} color="#6d8795" finish="glass" rotation={[Math.PI / 2, 0, 0]} segments={32} />
    </group>
  );
}

export function FixtureMesh({ fixture }: { fixture: SceneFixture }) {
  const { kind, width, depth, roomType } = fixture;
  return (
    <group
      position={[fixture.position[0], 0, fixture.position[1]]}
      rotation={[0, fixture.rotationY, 0]}
    >
      {kind === "bed" ? <Bed width={width} depth={depth} /> : null}
      {kind === "sofa" ? <Sofa width={width} depth={depth} /> : null}
      {kind === "dining_table" ? <DiningTable width={width} depth={depth} /> : null}
      {kind === "desk" ? <Desk width={width} depth={depth} /> : null}
      {kind === "wardrobe" ? <Wardrobe width={width} depth={depth} /> : null}
      {kind === "tv" ? <Television width={width} depth={depth} /> : null}
      {kind === "toilet" ? <Toilet depth={depth} /> : null}
      {kind === "sink" ? <Sink width={width} depth={depth} roomType={roomType} /> : null}
      {kind === "bathtub" ? <Bathtub width={width} depth={depth} /> : null}
      {kind === "shower" ? <Shower width={width} depth={depth} /> : null}
      {kind === "stove" ? <Stove width={width} depth={depth} /> : null}
      {kind === "counter" ? <Counter width={width} depth={depth} /> : null}
      {kind === "washer" ? <Washer width={width} depth={depth} /> : null}
    </group>
  );
}
