import { useState, type DragEvent } from "react"

type Sample = { id: string; title: string }

type Props = {
  samples: Sample[]
  busy: boolean
  onFile: (file: File) => void
  onSample: (id: string) => void
  activeSample: string | null
}

export function UploadPanel({ samples, busy, onFile, onSample, activeSample }: Props) {
  const [dragOver, setDragOver] = useState(false)

  const take = (file: File | undefined) => {
    if (!file || busy) return
    onFile(file)
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragOver(false)
    take(event.dataTransfer.files[0])
  }

  return (
    <section className="space-y-4">
      <label
        onDragOver={(event) => {
          event.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-start gap-1 rounded-xl border border-dashed px-4 py-4 transition ${
          dragOver ? "border-[#1f3a5f] bg-[#e7eef6]" : "border-[#c9bfb0] bg-[#fbf8f3]"
        } ${busy ? "pointer-events-none opacity-60" : ""}`}
      >
        <span className="text-sm font-medium text-[#1f3a5f]">上傳平面圖</span>
        <span className="text-sm text-[#6b645c]">拖放 PNG 或 JPG，或點這裡選擇。PDF 請先輸出成圖片。</span>
        <input
          className="sr-only"
          type="file"
          accept="image/png,image/jpeg,application/pdf"
          disabled={busy}
          onChange={(event) => {
            take(event.target.files?.[0])
            event.target.value = ""
          }}
        />
      </label>

      <div>
        <p className="mb-2 text-xs font-medium tracking-wide text-[#6b645c]">範例圖</p>
        <div className="flex flex-col gap-2">
          {samples.map((sample) => (
            <button
              key={sample.id}
              type="button"
              disabled={busy}
              onClick={() => onSample(sample.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition disabled:opacity-50 ${
                activeSample === sample.id
                  ? "bg-[#1f3a5f] text-[#f7f3ea]"
                  : "bg-[#f3eee6] text-[#1c1917] hover:bg-[#e7dfd2]"
              }`}
            >
              {sample.title}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}
