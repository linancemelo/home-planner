import { useEffect, useRef } from "react"
import { STUDIO_SHELL_HTML } from "./layout/studioShellHtml"
import { bootPlanStudio } from "./engine/planStudio"

/**
 * Mounts the imperative 2D/3D plan studio into a DOM host.
 * React owns the outer lifecycle; SVG + Three engines stay imperative for parity.
 */
export function PlanStudioHost() {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = STUDIO_SHELL_HTML
    const teardown = bootPlanStudio(host)
    return () => {
      teardown()
      host.innerHTML = ""
    }
  }, [])

  return (
    <div
      ref={hostRef}
      className="plan-studio-host"
      style={{ height: "100%", width: "100%" }}
    />
  )
}
