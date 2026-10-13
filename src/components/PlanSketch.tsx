import type { TracedPlan } from "@/lib/trace-floor-plan";

export function PlanSketch({
  trace,
  className = "",
}: {
  trace: TracedPlan;
  className?: string;
}) {
  return (
    <svg
      viewBox={`0 0 ${trace.width} ${trace.height}`}
      className={`h-full w-full bg-[#f7f4ee] ${className}`}
      role="img"
      aria-label="依牆線描出的平面圖"
    >
      <rect width={trace.width} height={trace.height} fill="#f7f4ee" />
      {trace.walls.map((wall, index) => (
        <line
          key={`wall-${index}`}
          x1={wall.x1}
          y1={wall.y1}
          x2={wall.x2}
          y2={wall.y2}
          stroke="#1a1a1a"
          strokeWidth={wall.thickness}
          strokeLinecap="square"
        />
      ))}
      {trace.windows.map((window, index) => (
        <line
          key={`window-${index}`}
          x1={window.x1}
          y1={window.y1}
          x2={window.x2}
          y2={window.y2}
          stroke="#2f6fad"
          strokeWidth={Math.max(2, trace.width * 0.004)}
          strokeLinecap="butt"
        />
      ))}
      {trace.doors.map((door, index) => {
        const width = Math.hypot(door.closedX - door.hingeX, door.closedY - door.hingeY);
        const stroke = Math.max(1.5, trace.width * 0.003);
        if (door.kind === "sliding") {
          const offsetX = ((door.openX - door.hingeX) / Math.max(width, 1)) * stroke * 1.6;
          const offsetY = ((door.openY - door.hingeY) / Math.max(width, 1)) * stroke * 1.6;
          const midX = (door.hingeX + door.closedX) / 2;
          const midY = (door.hingeY + door.closedY) / 2;
          const overlapX = (door.closedX - door.hingeX) * 0.06;
          const overlapY = (door.closedY - door.hingeY) * 0.06;
          return (
            <g key={`door-${index}`} stroke="#c4523a" strokeWidth={stroke}>
              <line
                x1={door.hingeX + offsetX}
                y1={door.hingeY + offsetY}
                x2={midX + overlapX + offsetX}
                y2={midY + overlapY + offsetY}
              />
              <line
                x1={midX - overlapX - offsetX}
                y1={midY - overlapY - offsetY}
                x2={door.closedX - offsetX}
                y2={door.closedY - offsetY}
              />
            </g>
          );
        }
        const cross =
          (door.closedX - door.hingeX) * (door.openY - door.hingeY) -
          (door.closedY - door.hingeY) * (door.openX - door.hingeX);
        const sweep = cross > 0 ? 1 : 0;
        return (
          <g key={`door-${index}`} fill="none" stroke="#c4523a" strokeWidth={Math.max(1.5, trace.width * 0.003)}>
            <line x1={door.hingeX} y1={door.hingeY} x2={door.closedX} y2={door.closedY} />
            <path
              d={`M ${door.closedX} ${door.closedY} A ${width} ${width} 0 0 ${sweep} ${door.openX} ${door.openY}`}
            />
          </g>
        );
      })}
    </svg>
  );
}
