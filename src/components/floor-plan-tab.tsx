"use client";

import "@/studio/theme/studio.css";
import { PlanStudioHost } from "@/studio/PlanStudioHost";

/** Legacy Vite floorplan studio (2D + 3D) mounted inside the Next app tab. */
export function FloorPlanTab() {
  return (
    <div className="h-full min-h-0 w-full overflow-hidden">
      <PlanStudioHost />
    </div>
  );
}
