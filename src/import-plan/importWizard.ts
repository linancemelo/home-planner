/**
 * 「從平面圖建立」wizard helpers (繁中).
 * DOM lives in the studio shell; this module drives detect → overlay → confirm.
 */
import type { PipelineResult } from "./detect/pipeline.ts"
import { detectFloorplan } from "./detect/pipeline.ts"
import { imageElementToSource, loadImageElement } from "./load-image.ts"
import { floorplanToBlueprint } from "./floorplanToBlueprint.ts"
import { drawFloorplanOverlay } from "./overlayDraw.ts"
import type { PlanBlueprint } from "../plan/types/blueprint.ts"

export type ImportWizardCallbacks = {
  onConfirm: (blueprint: PlanBlueprint) => void
  onCancel?: () => void
  /** Return false to abort confirm (e.g. user declined replace). */
  confirmReplace?: () => boolean
  hasCustomBlueprint?: () => boolean
}

export function bindImportWizard(root: ParentNode, cb: ImportWizardCallbacks): () => void {
  const modal = root.querySelector("#importPlanModal") as HTMLElement | null
  const fileIn = root.querySelector("#importPlanFile") as HTMLInputElement | null
  const canvas = root.querySelector("#importPlanCanvas") as HTMLCanvasElement | null
  const status = root.querySelector("#importPlanStatus") as HTMLElement | null
  const notesEl = root.querySelector("#importPlanNotes") as HTMLElement | null
  const btnPick = root.querySelector("#importPlanPick") as HTMLButtonElement | null
  const btnConfirm = root.querySelector("#importPlanConfirm") as HTMLButtonElement | null
  const btnCancel = root.querySelector("#importPlanCancel") as HTMLButtonElement | null
  const btnClose = root.querySelector("#importPlanClose") as HTMLButtonElement | null
  const openBtn = root.querySelector("#fromPlanImg") as HTMLButtonElement | null
  if (!modal || !fileIn || !canvas || !status || !btnPick || !btnConfirm || !btnCancel) {
    console.warn("[importWizard] modal markup missing")
    return () => {}
  }

  let objectUrl: string | null = null
  let result: PipelineResult | null = null
  let imgEl: HTMLImageElement | null = null
  let sourceName = ""

  const setStep = (msg: string) => {
    status.textContent = msg
  }

  const clearPreview = () => {
    result = null
    imgEl = null
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
    btnConfirm.disabled = true
    if (notesEl) notesEl.innerHTML = ""
    const ctx = canvas.getContext("2d")
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = "#f0e6d8"
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
  }

  const paint = () => {
    if (!result || !canvas) return
    const dpr = window.devicePixelRatio || 1
    const wrap = canvas.parentElement
    const w = Math.max(320, wrap?.clientWidth ?? 640)
    const h = Math.max(240, wrap?.clientHeight ?? 420)
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    const ctx = canvas.getContext("2d")
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    drawFloorplanOverlay(ctx, {
      image: imgEl,
      floorplan: result.floorplan,
      excavations: result.excavations,
      width: w,
      height: h,
    })
  }

  const open = () => {
    modal.hidden = false
    modal.setAttribute("aria-hidden", "false")
    clearPreview()
    setStep("選擇平面圖圖片（JPG／PNG）。支援標註 CAD 或行銷／配傢示意圖。")
  }

  const close = () => {
    modal.hidden = true
    modal.setAttribute("aria-hidden", "true")
    clearPreview()
    cb.onCancel?.()
  }

  const onFile = async (file: File) => {
    clearPreview()
    sourceName = file.name
    setStep("辨識中…（NTS：比例由牆厚假設 0.12 m 反推，不會猜看不清的開口）")
    btnConfirm.disabled = true
    try {
      objectUrl = URL.createObjectURL(file)
      imgEl = await loadImageElement(objectUrl)
      const source = imageElementToSource(imgEl)
      result = detectFloorplan(source, sourceName)
      const notes = result.floorplan.meta.notes ?? []
      if (notesEl) {
        notesEl.innerHTML = notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")
      }
      paint()
      const fp = result.floorplan
      setStep(
        `辨識完成：牆 ${fp.walls.length}、門 ${fp.doors.length}、窗 ${fp.windows.length}。請確認疊圖後寫入。`,
      )
      btnConfirm.disabled = fp.walls.length === 0
      if (fp.walls.length === 0) setStep("未偵測到可用牆段，請換一張更清楚的平面圖。")
    } catch (err) {
      console.error(err)
      setStep(err instanceof Error ? err.message : "辨識失敗")
    }
  }

  const onConfirm = () => {
    if (!result) return
    if (cb.hasCustomBlueprint?.() && cb.confirmReplace && !cb.confirmReplace()) return
    const bp = floorplanToBlueprint(result.floorplan)
    cb.onConfirm(bp)
    modal.hidden = true
    modal.setAttribute("aria-hidden", "true")
    clearPreview()
  }

  openBtn && (openBtn.disabled = false)
  openBtn && (openBtn.title = "上傳平面圖圖片，辨識牆／門／窗後寫入戶型")
  openBtn?.addEventListener("click", open)
  btnPick.addEventListener("click", () => fileIn.click())
  btnCancel.addEventListener("click", close)
  btnClose?.addEventListener("click", close)
  modal.querySelectorAll("[data-import-close]").forEach((el) => el.addEventListener("click", close))
  btnConfirm.addEventListener("click", onConfirm)
  fileIn.addEventListener("change", () => {
    const f = fileIn.files?.[0]
    fileIn.value = ""
    if (f) void onFile(f)
  })
  window.addEventListener("resize", paint)

  return () => {
    openBtn?.removeEventListener("click", open)
    window.removeEventListener("resize", paint)
    clearPreview()
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  )
}
