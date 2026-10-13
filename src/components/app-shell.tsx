"use client";

import { useState } from "react";
import { FloorPlanTab } from "@/components/floor-plan-tab";
import { HomePlannerApp } from "@/components/home-planner-app";
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
    <div className="min-h-full bg-[var(--studio-bg)] text-[var(--studio-ink)]">
      <header className="sticky top-0 z-40 border-b border-[var(--studio-line)] bg-[var(--studio-panel)]/95 backdrop-blur">
        <div className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 lg:px-8">
          <div className="min-w-0">
            <p className="truncate text-base font-semibold tracking-wide sm:text-lg">
              Home Planner
            </p>
            <p className="truncate text-sm text-[var(--studio-muted)]">
              {active.hint}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="主要功能"
            className="grid w-full grid-cols-2 rounded-lg border border-[var(--studio-line)] bg-white p-1 sm:w-auto sm:min-w-[17rem]"
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
                    "rounded-md px-3 py-2 text-sm font-medium transition-colors sm:px-5 sm:text-base",
                    selected
                      ? "bg-[var(--studio-accent)] text-white"
                      : "text-[var(--studio-muted)] hover:bg-[var(--studio-accent-soft)] hover:text-[var(--studio-accent)]"
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

      {tab === "planner" ? <HomePlannerApp /> : <FloorPlanTab />}
    </div>
  );
}
