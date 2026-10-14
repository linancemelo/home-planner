"use client"

import { useEffect, useId, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface GlassOption {
  value: string | number
  label: string
  disabled?: boolean
}

/** 與工作室「檔案」選單同一套外觀的下拉 */
export function GlassSelect({
  id,
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  id?: string
  value: string | number
  options: GlassOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState({ top: 0, left: 0, width: 0 })
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((option) => String(option.value) === String(value))

  useEffect(() => {
    if (!open) return
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false)
    }
    window.addEventListener("pointerdown", onPointer)
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("pointerdown", onPointer)
      window.removeEventListener("keydown", onKey)
    }
  }, [open])

  return (
    <div ref={rootRef} className={cn("relative min-w-0", className)}>
      <button
        type="button"
        id={id}
        className="glass-select"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (rect) {
            const menuHeight = Math.min(256, options.length * 40 + 12)
            const below = window.innerHeight - rect.bottom
            const top = below < menuHeight + 12 ? Math.max(8, rect.top - menuHeight - 6) : rect.bottom + 6
            setBox({ top, left: rect.left, width: rect.width })
          }
          setOpen((next) => !next)
        }}
      >
        <span className="truncate">{current?.label ?? ""}</span>
        <ChevronDown className={cn("size-4 shrink-0 opacity-70 transition-transform", open && "rotate-180")} />
      </button>
      {open
        ? createPortal(
        <div
          ref={menuRef}
          id={listId}
          role="listbox"
          className="glass-menu fixed z-[80] max-h-64 overflow-auto"
          style={{ top: box.top, left: box.left, width: box.width }}
        >
          {options.map((option) => {
            const selected = String(option.value) === String(value)
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return
                  onChange(String(option.value))
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            )
          })}
        </div>,
        document.body
      ) : null}
    </div>
  )
}
