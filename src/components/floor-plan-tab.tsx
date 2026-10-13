"use client";

import "@/studio/theme/studio.css";
import { PlanStudioHost } from "@/studio/PlanStudioHost";

/** Legacy Vite floorplan studio (2D + 3D) mounted inside the Next app tab. */
export function FloorPlanTab() {
  return (
    <div className="h-[calc(100dvh-3.5rem)] min-h-[36rem] w-full overflow-hidden">
      <PlanStudioHost />
    </div>
  );
}
