import { lazy, Suspense, useMemo, useState } from "react"
import { Plan2DOverlay } from "./components/Plan2DOverlay.tsx"
import { UploadPanel } from "./components/UploadPanel.tsx"

const Roam3D = lazy(() => import("./components/Roam3D.tsx").then((mod) => ({ default: mod.Roam3D })))
import { samples } from "./fixtures/manifest.ts"
import { compareFloorplans } from "./lib/compare.ts"
import { detectFloorplan, type PipelineResult } from "./lib/detect/pipeline.ts"
import { imageElementToSource, loadImageElement } from "./lib/load-image.ts"
import type { Floorplan } from "./types/floorplan.ts"

type Status = "idle" | "running" | "done" | "error"

export default function App() {
  const [status, setStatus] = useState<Status>("idle")
  const [error, setError] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [ownedUrl, setOwnedUrl] = useState<string | null>(null)
  const [result, setResult] = useState<PipelineResult | null>(null)
  const [sampleId, setSampleId] = useState<string | null>(null)
  const [showBinary, setShowBinary] = useState(false)
  const [showJson, setShowJson] = useState(false)
  const [mode, setMode] = useState<"2d" | "3d">("2d")

  const sample = samples.find((item) => item.id === sampleId) ?? null
  const comparison = useMemo(() => {
    if (!result || !sample?.expected) return null
    return compareFloorplans(result.floorplan, sample.expected)
  }, [result, sample])

  const run = async (img: HTMLImageElement, name: string, url: string, nextSample: string | null) => {
    setStatus("running")
    setError(null)
    setMode("2d")
    setSampleId(nextSample)
    setImageUrl(url)
    setResult(null)
    await new Promise((resolve) => setTimeout(resolve, 30))
    try {
      const source = imageElementToSource(img)
      if (source.width < 32 || source.height < 32) {
        throw new Error("圖太小，看不清牆線。")
      }
      const detected = detectFloorplan(source, name)
      setResult(detected)
      setStatus("done")
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "辨識失敗")
    }
  }

  const onFile = async (file: File) => {
    if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("error")
      setError("v1 還沒有把 PDF 第一頁轉成圖片。請先輸出成 PNG 或 JPG 再上傳。")
      return
    }
    if (!["image/png", "image/jpeg"].includes(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
      setStatus("error")
      setError("這個格式不支援。請改用 PNG 或 JPG。")
      return
    }
    if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    const url = URL.createObjectURL(file)
    setOwnedUrl(url)
    try {
      const img = await loadImageElement(url)
      await run(img, file.name, url, null)
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "無法讀取這個圖檔")
    }
  }

  const onSample = async (id: string) => {
    const found = samples.find((item) => item.id === id)
    if (!found) return
    try {
      const img = await loadImageElement(found.imageUrl)
      await run(img, `${found.id}.png`, found.imageUrl, found.id)
    } catch (err) {
      setStatus("error")
      setError(err instanceof Error ? err.message : "範例圖載入失敗")
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[#ddd4c6] bg-[#f7f3ea]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end justify-between gap-3 px-4 py-4">
          <div>
            <p className="text-xs font-medium tracking-[0.14em] text-[#9a3412]">V1 辨識 · V2 漫遊</p>
            <h1 className="text-2xl font-semibold text-[#1c1917]">平面圖解讀</h1>
            <p className="mt-1 max-w-xl text-sm text-[#5c564e]">
              上傳平面圖，只擷取牆、門、窗。看不清楚就略過並寫進備註。2D 確認後可走進 3D。
            </p>
          </div>
          <p className="text-xs text-[#6b645c]">公尺直接沿用 JSON。比例未採信，不能當施工尺寸。</p>
        </div>
      </header>

      <main
        className={`mx-auto gap-4 px-4 py-4 ${
          mode === "3d" && result
            ? "flex max-w-7xl flex-col"
            : "grid max-w-6xl lg:grid-cols-[300px_minmax(0,1fr)]"
        }`}
      >
        {!(mode === "3d" && result) && (
          <aside className="space-y-4">
            <UploadPanel
              samples={samples.map((item) => ({ id: item.id, title: item.title }))}
              busy={status === "running"}
              onFile={(file) => void onFile(file)}
              onSample={(id) => void onSample(id)}
              activeSample={sampleId}
            />
            <ResultCard
              status={status}
              error={error}
              result={result}
              comparison={comparison}
              sampleDescription={sample?.description ?? null}
              showBinary={showBinary}
              showJson={showJson}
              mode={mode}
              onToggleBinary={() => setShowBinary((v) => !v)}
              onToggleJson={() => setShowJson((v) => !v)}
              onDownload={() => result && downloadPlan(result.floorplan)}
              onEnter3D={() => setMode("3d")}
              onExit3D={() => setMode("2d")}
            />
          </aside>
        )}
        <section className="min-h-[70vh]">
          {status === "running" ? (
            <div className="flex h-full min-h-[420px] items-center justify-center rounded-xl border border-[#ddd4c6] bg-[#f7f3ea] text-sm text-[#5c564e]">
              正在前處理，並擷取牆、門、窗…
            </div>
          ) : mode === "3d" && result ? (
            <Suspense
              fallback={
                <div className="flex h-[72vh] min-h-[420px] items-center justify-center rounded-xl border border-[#ddd4c6] bg-[#f7f3ea] text-sm text-[#5c564e]">
                  正在準備 3D…
                </div>
              }
            >
              <Roam3D plan={result.floorplan} onBack={() => setMode("2d")} />
            </Suspense>
          ) : (
            <Plan2DOverlay imageUrl={imageUrl} result={result} showBinary={showBinary} />
          )}
        </section>
      </main>
    </div>
  )
}

function ResultCard({
  status,
  error,
  result,
  comparison,
  sampleDescription,
  showBinary,
  showJson,
  mode,
  onToggleBinary,
  onToggleJson,
  onDownload,
  onEnter3D,
  onExit3D,
}: {
  status: Status
  error: string | null
  result: PipelineResult | null
  comparison: ReturnType<typeof compareFloorplans> | null
  sampleDescription: string | null
  showBinary: boolean
  showJson: boolean
  mode: "2d" | "3d"
  onToggleBinary: () => void
  onToggleJson: () => void
  onDownload: () => void
  onEnter3D: () => void
  onExit3D: () => void
}) {
  if (status === "idle") {
    return (
      <div className="rounded-xl bg-[#f7f3ea] px-4 py-3 text-sm text-[#5c564e]">
        尚未載入平面圖。選一張範例，或上傳自己的 PNG / JPG。
      </div>
    )
  }
  if (status === "error" && error) {
    return <div className="rounded-xl bg-[#fde8e6] px-4 py-3 text-sm text-[#9f1239]">{error}</div>
  }
  if (!result || status === "running") {
    return <div className="rounded-xl bg-[#f7f3ea] px-4 py-3 text-sm text-[#5c564e]">辨識進行中。</div>
  }

  const { floorplan } = result
  const confidence = floorplan.meta.detectionConfidence
  return (
    <div className="space-y-3 rounded-xl bg-[#f7f3ea] px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">辨識結果</h2>
        {confidence !== undefined && (
          <span className="text-xs text-[#6b645c]">信心 {Math.round(confidence * 100)}%</span>
        )}
      </div>
      <p className="text-sm text-[#3f3a34]">
        牆 {floorplan.walls.length}　門 {floorplan.doors.length}　窗 {floorplan.windows.length}
      </p>
      <p className="text-xs leading-5 text-[#6b645c]">
        {floorplan.meta.imageWidthPx}×{floorplan.meta.imageHeightPx} px　
        {floorplan.meta.metersPerPixel} m/px　原點 {originLabel(floorplan.meta.coordinateOrigin)}　
        天花 {floorplan.meta.ceilingHeightM} m（假設）
      </p>
      {sampleDescription && <p className="text-xs text-[#5c564e]">{sampleDescription}</p>}
      {comparison && (
        <p className={`text-xs ${comparison.ok ? "text-[#166534]" : "text-[#9a3412]"}`}>
          與手標幾何{comparison.ok ? "相符" : "有差距"}：牆 {comparison.walls.matched}/
          {comparison.walls.expected}、門 {comparison.doors.matched}/{comparison.doors.expected}、窗{" "}
          {comparison.windows.matched}/{comparison.windows.expected}
        </p>
      )}
      <div>
        <h3 className="mb-1 text-xs font-medium text-[#6b645c]">備註</h3>
        <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-[#3f3a34]">
          {(floorplan.meta.notes ?? ["沒有備註。"]).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
      {mode === "3d" && (
        <p className="text-xs leading-5 text-[#5c564e]">
          拖曳視角（不鎖指標）、WASD 移動、對準門按 E 或輕點門扇。高度用天花 {floorplan.meta.ceilingHeightM} m。
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onDownload}
          className="rounded-lg bg-[#1f3a5f] px-3 py-1.5 text-sm text-[#f7f3ea]"
        >
          下載 JSON
        </button>
        {mode === "2d" ? (
          <button type="button" onClick={onEnter3D} className="rounded-lg bg-[#9a3412] px-3 py-1.5 text-sm text-[#f7f3ea]">
            進入 3D
          </button>
        ) : (
          <button type="button" onClick={onExit3D} className="rounded-lg bg-[#efe8dc] px-3 py-1.5 text-sm">
            回到 2D
          </button>
        )}
        <button type="button" onClick={onToggleBinary} className="rounded-lg bg-[#efe8dc] px-3 py-1.5 text-sm">
          {showBinary ? "看原圖" : "看前處理"}
        </button>
        <button type="button" onClick={onToggleJson} className="rounded-lg bg-[#efe8dc] px-3 py-1.5 text-sm">
          {showJson ? "收合 JSON" : "檢視 JSON"}
        </button>
      </div>
      {showJson && (
        <pre className="max-h-64 overflow-auto rounded-lg bg-[#1c1917] p-3 text-[11px] leading-4 text-[#f4efe6]">
          {JSON.stringify(floorplan, null, 2)}
        </pre>
      )}
      <details className="text-xs text-[#6b645c]">
        <summary className="cursor-pointer">診斷</summary>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          {result.diagnostics.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function originLabel(origin: Floorplan["meta"]["coordinateOrigin"]): string {
  return origin === "bottom-left" ? "左下" : "左上"
}

function downloadPlan(plan: Floorplan) {
  const blob = new Blob([JSON.stringify(plan, null, 2) + "\n"], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  const base = plan.meta.sourceName.replace(/\.[^.]+$/, "") || "floorplan"
  anchor.href = url
  anchor.download = `${base}.floorplan.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
