/**
 * Topology / assemble smoke tests (offline mock, no API keys).
 * Usage: npm run test:ai
 */
import { assembleFromAiAndDetect } from "../src/import-plan/ai/assemble.ts"
import {
  buildRoomAccessGraph,
  ensureRoomAccess,
  roomsFromPolygons,
} from "../src/import-plan/ai/connectivity.ts"
import { mockFloorplanAiProvider } from "../src/import-plan/ai/mockProvider.ts"
import { nullFloorplanAiProvider } from "../src/import-plan/ai/nullProvider.ts"
import {
  assertNotFloorplanJson,
  parseAiFloorplanProposal,
} from "../src/import-plan/ai/proposal.ts"
import { openAiVisionFloorplanProvider } from "../src/import-plan/ai/openaiVision.ts"
import { geminiVisionFloorplanProvider } from "../src/import-plan/ai/geminiVision.ts"
import type { PipelineResult } from "../src/import-plan/detect/pipeline.ts"
import type { Floorplan, Wall } from "../src/import-plan/floorplan.ts"
import { parseFloorplan } from "../src/import-plan/schema.ts"
import { wallStableId } from "../src/import-plan/ids.ts"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let failed = 0

function assert(cond: boolean, message: string): void {
  if (!cond) {
    failed++
    console.error("FAIL", message)
  } else {
    console.log("ok ", message)
  }
}

function wall(a: { x: number; y: number }, b: { x: number; y: number }, t = 0.12): Wall {
  return {
    id: wallStableId(a, b, t),
    a,
    b,
    thicknessM: t,
    thicknessAssumed: true,
  }
}

function baseFloorplan(walls: Wall[], doors: Floorplan["doors"] = []): Floorplan {
  return parseFloorplan({
    version: 1,
    meta: {
      sourceName: "test",
      imageWidthPx: 800,
      imageHeightPx: 600,
      metersPerPixel: 0.01,
      scaleTrusted: false,
      coordinateOrigin: "bottom-left",
      ceilingHeightM: 2.8,
      ceilingHeightAssumed: true,
      notes: [],
    },
    walls,
    doors,
    windows: [],
  })
}

function emptyDetect(fp: Floorplan): PipelineResult {
  return {
    floorplan: fp,
    excavations: [],
    binary: { width: 1, height: 1, ink: new Uint8Array([0]) },
    diagnostics: ["test"],
  }
}

// 1) Proposal schema rejects Floorplan-shaped payloads via assert helper
{
  let threw = false
  try {
    assertNotFloorplanJson({
      version: 1,
      walls: [],
      doors: [],
      windows: [],
      meta: {},
    })
  } catch {
    threw = true
  }
  assert(threw, "assertNotFloorplanJson rejects Floorplan-shaped JSON")
}

// 2) Null provider offline
assert(!nullFloorplanAiProvider.isConfigured(), "Null provider not configured")
assert((await nullFloorplanAiProvider.propose({
  sourceName: "x",
  imageWidthPx: 1,
  imageHeightPx: 1,
})) === null, "Null propose returns null")

// 3) Vision stubs offline without keys
assert(!openAiVisionFloorplanProvider.isConfigured(), "OpenAI stub offline without key")
assert(!geminiVisionFloorplanProvider.isConfigured(), "Gemini stub offline without key")

// 4) Mock proposal parses
const proposal = await mockFloorplanAiProvider.propose({
  sourceName: "mock.png",
  imageWidthPx: 700,
  imageHeightPx: 300,
})
assert(proposal != null && proposal.kind === "ai-proposal", "Mock emits ai-proposal")
parseAiFloorplanProposal(proposal)

// 5) Two rooms sealed by a partition → connectivity adds opening or removes seal
{
  const partition = wall({ x: 4, y: 0.1 }, { x: 4, y: 2.9 })
  const walls = [
    wall({ x: 0, y: 0 }, { x: 7, y: 0 }),
    wall({ x: 7, y: 0 }, { x: 7, y: 3 }),
    wall({ x: 7, y: 3 }, { x: 0, y: 3 }),
    wall({ x: 0, y: 3 }, { x: 0, y: 0 }),
    partition,
  ]
  const fp = baseFloorplan(walls, [])
  const rooms = roomsFromPolygons([
    {
      id: "r-living",
      label: "客廳",
      polygon: [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 3 },
        { x: 0, y: 3 },
      ],
    },
    {
      id: "r-bed",
      label: "臥室",
      polygon: [
        { x: 4, y: 0 },
        { x: 7, y: 0 },
        { x: 7, y: 3 },
        { x: 4, y: 3 },
      ],
    },
  ])
  const conn = ensureRoomAccess(fp, rooms)
  assert(
    conn.addedOpeningIds.length > 0 || conn.removedWallIds.length > 0,
    "sealed rooms get opening or seal removed",
  )
  assert(conn.sealedRoomsFixed.length >= 1, "reports sealed rooms fixed")
  const graph = buildRoomAccessGraph(rooms, conn.floorplan.doors)
  const linked =
    (graph.get("r-living")?.has("r-bed") ?? false) ||
    (graph.get("r-bed")?.has("r-living") ?? false) ||
    conn.removedWallIds.includes(partition.id)
  assert(linked || conn.floorplan.doors.length > 0, "rooms gain access path")
}

// 6) assembleFromAiAndDetect with mock: furniture ignored, mode ai+rules
{
  const walls = [
    wall({ x: 0, y: 0 }, { x: 7, y: 0 }),
    wall({ x: 7, y: 0 }, { x: 7, y: 3 }),
    wall({ x: 7, y: 3 }, { x: 0, y: 3 }),
    wall({ x: 0, y: 3 }, { x: 0, y: 0 }),
    wall({ x: 4, y: 0 }, { x: 4, y: 3 }),
  ]
  const detect = emptyDetect(baseFloorplan(walls))
  const assembled = assembleFromAiAndDetect(detect, proposal)
  assert(assembled.mode === "ai+rules", "assemble mode ai+rules with proposal")
  assert(assembled.proposalUsed, "proposalUsed true")
  parseFloorplan(assembled.floorplan)
  const notes = assembled.floorplan.meta.notes?.join("\n") ?? ""
  assert(notes.includes("家具") || notes.includes("furniture") || notes.includes("略過"), "furniture hint noted")
}

// 7) assemble without proposal → heuristic
{
  const walls = [
    wall({ x: 0, y: 0 }, { x: 4, y: 0 }),
    wall({ x: 4, y: 0 }, { x: 4, y: 3 }),
    wall({ x: 4, y: 3 }, { x: 0, y: 3 }),
    wall({ x: 0, y: 3 }, { x: 0, y: 0 }),
  ]
  const assembled = assembleFromAiAndDetect(emptyDetect(baseFloorplan(walls)), null)
  assert(assembled.mode === "heuristic", "assemble mode heuristic without proposal")
}

// 8) QA fixture jpgs present
{
  const root = path.resolve(__dirname, "../src/import-plan/fixtures/real-samples")
  for (const name of ["2b69218a-b.jpg", "964226aa-b.jpg", "bb00b5bf-b.jpg"]) {
    assert(fs.existsSync(path.join(root, name)), `fixture ${name}`)
  }
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`)
  process.exit(1)
}
console.log("\nAll AI assemble / topology checks passed.")
