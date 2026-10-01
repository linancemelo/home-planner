# AI-assisted floor-plan recognition (architecture)

**Contract:** vision models emit an **`AiFloorplanProposal` only** — never a final `Floorplan` JSON and never a `PlanBlueprint`.

```
image → (optional) FloorplanAiProvider.propose() → AiFloorplanProposal
      → heuristic detectFloorplan() → PipelineResult
      → assembleFromAiAndDetect(detect, proposal)  // rules + connectivity
      → overlay confirm → floorplanToBlueprint()
```

## Hard rules (enforced in assemble / connectivity, not by the model)

1. **Every room needs door/opening access** — sealed rooms get an opening on a shared wall, or a short spurious seal is removed, with a note.
2. **No spurious walls sealing corridors** — prefer topology (access graph) over keeping extra wall segments.
3. **Furniture ≠ structure** — AI `wallHints` with `role: "furniture"` are ignored; heuristic furniture rejection still applies.
4. **AI proposes; rules assemble** — door/window *candidates* and OCR labels feed the assembler; IDs, excavation, and schema validation stay in postprocess / parseFloorplan.

## Offline / keys

| Provider | When used |
| --- | --- |
| `NullFloorplanAiProvider` | default (no keys) |
| `MockFloorplanAiProvider` | tests / demos |
| `OpenAiVisionFloorplanProvider` | `VITE_OPENAI_API_KEY` set (`isConfigured()`) |
| `GeminiVisionFloorplanProvider` | `VITE_GEMINI_API_KEY` set |

Stubs read keys from Vite env; vision HTTP is not required for heuristic+rules path. Copy `.env.example` → `.env.local` when plugging a key later.

## UI

Import wizard badge: **啟發式** (null / offline) vs **AI+規則** (configured provider path). Overlay confirm is unchanged.
