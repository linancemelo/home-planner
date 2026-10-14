"use client";

import { useState } from "react";
import { House } from "lucide-react";
import { FloorPlanTab } from "@/components/floor-plan-tab";
import { LiquidGlass } from "@/components/liquid-glass";
import { HomePlannerApp } from "@/components/home-planner-app";
import { SITE_NAME, SITE_TAGLINE } from "@/lib/site";
import { cn } from "@/lib/utils";

type AppTab = "planner" | "floorplan";

const TABS: { id: AppTab; label: string; shortLabel: string; hint: string }[] =
  [
    {
      id: "planner",
      label: "資產規劃",
      shortLabel: "規劃",
      hint: "頭期款、房貸與預售分期",
    },
    {
      id: "floorplan",
      label: "平面／3D",
      shortLabel: "平面",
      hint: "室內平面圖工作室與 3D 漫遊",
    },
  ];

export function AppShell() {
  const [tab, setTab] = useState<AppTab>("planner");
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div
      className={cn(
        "flex min-h-dvh flex-col text-[var(--studio-ink)]",
        tab === "floorplan" && "h-dvh overflow-hidden"
      )}
    >
      <header
        className={cn(
          "lglass z-40 mx-5 mt-5 shrink-0 rounded-[28px]",
          tab === "planner" && "sticky top-3"
        )}
      >
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-5 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-white text-[#0b0d12] shadow-[inset_0_-2px_4px_rgba(0,0,0,0.18),0_6px_18px_rgba(0,0,0,0.35)]"
            >
              <House className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="truncate text-base font-semibold sm:text-lg">
                {SITE_NAME}
                <span className="ml-2 text-sm font-normal text-[var(--studio-muted)]">
                  {SITE_TAGLINE}
                </span>
              </p>
              <p className="truncate text-sm text-[var(--studio-muted)]">
                {active.hint}
              </p>
            </div>
          </div>

          <div
            role="tablist"
            aria-label="主要功能"
            className="grid w-full grid-cols-2 gap-1 rounded-full bg-black/30 p-1 shadow-[inset_0_1px_3px_rgba(0,0,0,0.5),inset_0_-1px_0_rgba(255,255,255,0.08)] sm:w-auto sm:min-w-[17rem]"
          >
            {TABS.map((item) => {
              const selected = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => setTab(item.id)}
                  className={cn(
                    "rounded-full px-3 py-2 text-sm font-medium transition-colors sm:px-5 sm:text-base",
                    selected
                      ? "bg-white font-bold text-[#0b0d12] shadow-[inset_0_-2px_4px_rgba(0,0,0,0.15),0_4px_14px_rgba(0,0,0,0.35)]"
                      : "text-[var(--studio-muted)] hover:bg-white/5 hover:text-[var(--studio-ink)]"
                  )}
                >
                  <span className="sm:hidden">{item.shortLabel}</span>
                  <span className="hidden sm:inline">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <LiquidGlass />
      <div className={tab === "floorplan" ? "min-h-0 flex-1" : undefined}>
        {tab === "planner" ? <HomePlannerApp /> : <FloorPlanTab />}
      </div>
    </div>
  );
}
