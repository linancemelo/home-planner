"use client";

import { useState } from "react";
import { FloorPlanTab } from "@/components/floor-plan-tab";
import { HomePlannerApp } from "@/components/home-planner-app";
import { ThemeToggle } from "@/components/theme-toggle";
import { cn } from "@/lib/utils";

type AppTab = "planner" | "floorplan";

const TABS: { id: AppTab; label: string; hint: string }[] = [
  { id: "planner", label: "資產規劃", hint: "頭期款、房貸與預售分期" },
  { id: "floorplan", label: "平面／3D", hint: "上傳平面圖與室內場景" },
];

export function AppShell() {
  const [tab, setTab] = useState<AppTab>("planner");
  const active = TABS.find((item) => item.id === tab) ?? TABS[0];

  return (
    <div className="min-h-full bg-[radial-gradient(1200px_circle_at_top_left,oklch(0.92_0.05_175/0.45),transparent_45%),radial-gradient(900px_circle_at_top_right,oklch(0.93_0.06_275/0.35),transparent_40%)] dark:bg-[radial-gradient(1000px_circle_at_top_left,oklch(0.3_0.05_175/0.25),transparent_45%),radial-gradient(800px_circle_at_top_right,oklch(0.28_0.06_275/0.2),transparent_40%)]">
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-3 px-3 sm:px-6">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight sm:text-base">
              Home Planner
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {active.hint}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="主要功能"
            className="grid grid-cols-2 rounded-xl border bg-muted/50 p-1"
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
                    "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors sm:px-4",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <ThemeToggle />
        </div>
      </header>

      {tab === "planner" ? (
        <HomePlannerApp />
      ) : (
        <div className="mx-auto max-w-[1600px] px-3 py-3 sm:px-6 sm:py-4">
          <FloorPlanTab />
        </div>
      )}
    </div>
  );
}
