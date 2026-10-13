"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import type { Group } from "three";

/** 人物以 1.75 公尺的成人比例建模，再依身高等比縮放。 */
const MODEL_HEIGHT_M = 1.75;

export const MEMBERS = [
  { id: "jisoo", group: "BLACKPINK", name: "Jisoo", hair: "#1a1a1a", top: "#f3f3f3", bottom: "#2a2a2a", hairStyle: "long", accent: "" },
  { id: "jennie", group: "BLACKPINK", name: "Jennie", hair: "#141414", top: "#1c1c1c", bottom: "#141414", hairStyle: "long", accent: "" },
  { id: "rose", group: "BLACKPINK", name: "Rosé", hair: "#d9c091", top: "#f3e4e8", bottom: "#3a3a3a", hairStyle: "long", accent: "" },
  { id: "lisa", group: "BLACKPINK", name: "Lisa", hair: "#1a1a1a", top: "#e6b84a", bottom: "#242424", hairStyle: "long", accent: "" },
  { id: "karina", group: "aespa", name: "Karina", hair: "#16181e", top: "#2a3344", bottom: "#1c1c1c", hairStyle: "long", accent: "" },
  { id: "giselle", group: "aespa", name: "Giselle", hair: "#6a4932", top: "#efe6d8", bottom: "#3c3834", hairStyle: "long", accent: "" },
  { id: "winter", group: "aespa", name: "Winter", hair: "#c9ced6", top: "#d5e3f4", bottom: "#4a5564", hairStyle: "short", accent: "" },
  { id: "ningning", group: "aespa", name: "Ningning", hair: "#241820", top: "#e7a8ba", bottom: "#32282c", hairStyle: "long", accent: "#e7a0b4" },
] as const;

export type MemberId = (typeof MEMBERS)[number]["id"];

export interface CharacterHandle {
  root: Group | null;
  /** 走路擺動，-1 到 1 */
  setStride: (swing: number) => void;
}

type CharacterProps = {
  member: MemberId;
  heightM: number;
};

const SKIN = "#e7c2a4";

function SkinMat() {
  return <meshPhysicalMaterial color={SKIN} roughness={0.48} metalness={0} sheen={0.25} sheenColor="#f3d2be" />;
}

function Cloth({ color }: { color: string }) {
  return <meshStandardMaterial color={color} roughness={0.78} />;
}

function Hand({ side }: { side: 1 | -1 }) {
  return (
    <group>
      <mesh position={[0, -0.035, 0.004]}>
        <boxGeometry args={[0.07, 0.08, 0.022]} />
        <SkinMat />
      </mesh>
      {[-0.026, -0.009, 0.009, 0.026].map((x) => (
        <mesh key={x} position={[x, -0.1, 0.006]}>
          <capsuleGeometry args={[0.007, 0.045, 4, 8]} />
          <SkinMat />
        </mesh>
      ))}
      <mesh position={[side * 0.04, -0.05, 0.01]} rotation={[0.4, 0, side * -0.7]}>
        <capsuleGeometry args={[0.008, 0.038, 4, 8]} />
        <SkinMat />
      </mesh>
    </group>
  );
}

export const Character = forwardRef<CharacterHandle, CharacterProps>(
  function Character({ member, heightM }, ref) {
    const root = useRef<Group>(null);
    const leftThigh = useRef<Group>(null);
    const rightThigh = useRef<Group>(null);
    const leftKnee = useRef<Group>(null);
    const rightKnee = useRef<Group>(null);
    const leftArm = useRef<Group>(null);
    const rightArm = useRef<Group>(null);
    const leftElbow = useRef<Group>(null);
    const rightElbow = useRef<Group>(null);

    useImperativeHandle(
      ref,
      () => ({
        get root() {
          return root.current;
        },
        setStride(swing: number) {
          const pose = (
            thigh: Group | null,
            knee: Group | null,
            arm: Group | null,
            elbow: Group | null,
            sign: number,
          ) => {
            const step = swing * sign;
            if (thigh) thigh.rotation.x = step * 0.72;
            if (knee) knee.rotation.x = 0.06 + Math.max(0, step) * 1.15;
            if (arm) arm.rotation.x = -step * 0.62;
            if (elbow) elbow.rotation.x = 0.28 + Math.max(0, -step) * 0.4;
          };
          pose(leftThigh.current, leftKnee.current, leftArm.current, leftElbow.current, 1);
          pose(rightThigh.current, rightKnee.current, rightArm.current, rightElbow.current, -1);
        },
      }),
      [],
    );

    const look = MEMBERS.find((item) => item.id === member) ?? MEMBERS[0];
    const scale = heightM / MODEL_HEIGHT_M;
    const longHair = look.hairStyle === "long";

    const legs = [
      { x: -0.09, thigh: leftThigh, knee: leftKnee },
      { x: 0.09, thigh: rightThigh, knee: rightKnee },
    ] as const;
    const arms = [
      { x: -0.2, side: -1 as const, arm: leftArm, elbow: leftElbow },
      { x: 0.2, side: 1 as const, arm: rightArm, elbow: rightElbow },
    ] as const;

    return (
      <group ref={root}>
        <group scale={scale}>
          {legs.map((leg) => (
            <group key={leg.x} ref={leg.thigh} position={[leg.x, 0.92, 0]}>
              <mesh position={[0, -0.22, 0]}>
                <capsuleGeometry args={[0.062, 0.31, 8, 16]} />
                <Cloth color={look.bottom} />
              </mesh>
              <group ref={leg.knee} position={[0, -0.44, 0]}>
                <mesh position={[0, -0.2, 0]}>
                  <capsuleGeometry args={[0.046, 0.3, 8, 16]} />
                  <Cloth color={look.bottom} />
                </mesh>
                <mesh position={[0, -0.43, 0.05]}>
                  <boxGeometry args={[0.078, 0.07, 0.23]} />
                  <meshStandardMaterial color="#2c2c2c" roughness={0.55} />
                </mesh>
              </group>
            </group>
          ))}

          <mesh position={[0, 0.98, 0]}>
            <capsuleGeometry args={[0.11, 0.12, 8, 16]} />
            <Cloth color={look.bottom} />
          </mesh>
          <mesh position={[0, 1.18, 0]} scale={[0.92, 1, 0.72]}>
            <capsuleGeometry args={[0.1, 0.16, 8, 16]} />
            <Cloth color={look.top} />
          </mesh>
          <mesh position={[0, 1.36, 0.01]} scale={[1.05, 1, 0.7]}>
            <capsuleGeometry args={[0.12, 0.16, 8, 16]} />
            <Cloth color={look.top} />
          </mesh>

          {arms.map((arm) => (
            <group key={arm.x} ref={arm.arm} position={[arm.x, 1.42, 0]}>
              <mesh position={[0, -0.15, 0]}>
                <capsuleGeometry args={[0.04, 0.21, 6, 12]} />
                <Cloth color={look.top} />
              </mesh>
              <group ref={arm.elbow} position={[0, -0.3, 0]}>
                <mesh position={[0, -0.125, 0]}>
                  <capsuleGeometry args={[0.033, 0.18, 6, 12]} />
                  <SkinMat />
                </mesh>
                <group position={[0, -0.25, 0]}>
                  <Hand side={arm.side} />
                </group>
              </group>
            </group>
          ))}

          <mesh position={[0, 1.5, 0]}>
            <capsuleGeometry args={[0.042, 0.06, 6, 10]} />
            <SkinMat />
          </mesh>
          <mesh position={[0, 1.64, 0.008]}>
            <sphereGeometry args={[0.112, 32, 24]} />
            <SkinMat />
          </mesh>
          <mesh position={[-0.034, 1.66, 0.098]}>
            <sphereGeometry args={[0.013, 12, 10]} />
            <meshStandardMaterial color="#f7f4f0" roughness={0.25} />
          </mesh>
          <mesh position={[0.034, 1.66, 0.098]}>
            <sphereGeometry args={[0.013, 12, 10]} />
            <meshStandardMaterial color="#f7f4f0" roughness={0.25} />
          </mesh>
          <mesh position={[-0.034, 1.66, 0.108]}>
            <sphereGeometry args={[0.007, 10, 8]} />
            <meshStandardMaterial color="#3a2a22" roughness={0.35} />
          </mesh>
          <mesh position={[0.034, 1.66, 0.108]}>
            <sphereGeometry args={[0.007, 10, 8]} />
            <meshStandardMaterial color="#3a2a22" roughness={0.35} />
          </mesh>
          <mesh position={[0, 1.64, 0.108]} rotation={[Math.PI / 2, 0, 0]}>
            <capsuleGeometry args={[0.012, 0.018, 4, 8]} />
            <SkinMat />
          </mesh>
          <mesh position={[0, 1.615, 0.1]}>
            <boxGeometry args={[0.028, 0.008, 0.012]} />
            <meshStandardMaterial color="#c48b86" roughness={0.45} />
          </mesh>
          <mesh position={[-0.108, 1.64, 0]}>
            <sphereGeometry args={[0.02, 10, 8]} />
            <SkinMat />
          </mesh>
          <mesh position={[0.108, 1.64, 0]}>
            <sphereGeometry args={[0.02, 10, 8]} />
            <SkinMat />
          </mesh>

          <mesh position={[0, 1.7, -0.01]}>
            <sphereGeometry args={[0.116, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.48]} />
            <meshStandardMaterial color={look.hair} roughness={0.42} />
          </mesh>
          {longHair ? (
            <>
              <mesh position={[0, 1.32, -0.1]}>
                <capsuleGeometry args={[0.04, 0.46, 6, 12]} />
                <meshStandardMaterial color={look.hair} roughness={0.45} />
              </mesh>
              <mesh position={[-0.055, 1.4, -0.08]}>
                <capsuleGeometry args={[0.022, 0.32, 4, 8]} />
                <meshStandardMaterial color={look.hair} roughness={0.45} />
              </mesh>
              <mesh position={[0.055, 1.4, -0.08]}>
                <capsuleGeometry args={[0.022, 0.32, 4, 8]} />
                <meshStandardMaterial color={look.accent || look.hair} roughness={0.45} />
              </mesh>
            </>
          ) : (
            <mesh position={[0, 1.58, -0.02]} scale={[1, 0.75, 0.9]}>
              <sphereGeometry args={[0.114, 20, 14]} />
              <meshStandardMaterial color={look.hair} roughness={0.42} />
            </mesh>
          )}
        </group>
      </group>
    );
  },
);
