"use client";

import { CheckCircle2 } from "lucide-react";
import { formatWan, formatYearMonth, formatYuanAsWan } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlannerResult } from "@/lib/types";

interface TimelineViewProps {
  result: PlannerResult;
}

export function TimelineView({ result }: TimelineViewProps) {
  if (result.timeline.length === 0) {
    return null;
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">資金時間線</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          每年累積現金與達標時間點，進度條對應目標金額
        </p>
      </div>

      {/* 手機：直向時間軸 */}
      <ol className="relative space-y-0 md:hidden">
        {result.timeline.map((point, index) => (
          <li key={point.year} className="relative flex gap-3 pb-6 last:pb-0">
            {index < result.timeline.length - 1 ? (
              <span className="absolute top-4 bottom-0 left-[11px] w-0.5 bg-linear-to-b from-teal to-indigo/40" />
            ) : null}
            <span
              className={cn(
                "relative z-10 mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border-2",
                point.isTargetYear
                  ? "border-teal bg-teal text-primary-foreground"
                  : "border-teal/40 bg-background"
              )}
            >
              {point.isTargetYear ? <CheckCircle2 className="size-3.5" /> : null}
            </span>
            <div className="min-w-0 flex-1 rounded-xl border bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium tabular-nums">{point.year}</p>
                <p className="text-sm font-semibold tabular-nums text-teal">
                  {formatYuanAsWan(point.cumulative)} 萬
                </p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-linear-to-r from-teal to-amber"
                  style={{
                    width: `${Math.min(100, point.coveragePercent)}%`,
                  }}
                />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {point.isTargetYear && point.targetMonth
                  ? `達標於 ${formatYearMonth(point.year, point.targetMonth)}`
                  : `覆蓋 ${formatWan(point.coveragePercent, 0)}%`}
              </p>
            </div>
          </li>
        ))}
      </ol>

      {/* 平板以上：橫向卡片軸 */}
      <div className="hidden md:block">
        <div className="-mx-1 overflow-x-auto px-1 pb-2">
          <div
            className="relative flex min-w-max gap-4 pt-2 pb-1"
            style={{ minWidth: `${result.timeline.length * 9}rem` }}
          >
            <div className="absolute top-6 right-6 left-6 h-1 rounded-full bg-linear-to-r from-teal via-indigo to-amber" />
            {result.timeline.map((point) => (
              <div
                key={point.year}
                className="relative z-10 w-36 shrink-0"
              >
                <div className="flex justify-center">
                  <span
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full border-2 shadow-sm",
                      point.isTargetYear
                        ? "border-teal bg-teal text-primary-foreground"
                        : "border-white bg-indigo text-[0] dark:border-card"
                    )}
                  >
                    {point.isTargetYear ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      <span className="size-2 rounded-full bg-background" />
                    )}
                  </span>
                </div>
                <div
                  className={cn(
                    "mt-3 rounded-xl border p-3 text-center shadow-xs",
                    point.isTargetYear
                      ? "border-teal/40 bg-teal/10"
                      : "bg-card"
                  )}
                >
                  <p className="text-sm font-semibold tabular-nums">
                    {point.year}
                  </p>
                  <p className="mt-1 text-base font-semibold tabular-nums text-teal">
                    {formatYuanAsWan(point.cumulative)} 萬
                  </p>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-linear-to-r from-teal to-indigo"
                      style={{
                        width: `${Math.min(100, point.coveragePercent)}%`,
                      }}
                    />
                  </div>
                  {point.isTargetYear && point.targetMonth ? (
                    <p className="mt-2 text-[11px] font-medium text-teal">
                      達標 {formatYearMonth(point.year, point.targetMonth)}
                    </p>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      {formatWan(point.coveragePercent, 0)}%
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="hidden overflow-x-auto rounded-xl border sm:block">
        <table className="w-full min-w-[360px] text-sm">
          <thead className="bg-muted/50 text-left">
            <tr>
              <th className="px-3 py-2.5 font-medium">年度</th>
              <th className="px-3 py-2.5 font-medium">累積現金</th>
              <th className="px-3 py-2.5 font-medium">覆蓋率</th>
              <th className="px-3 py-2.5 font-medium">狀態</th>
            </tr>
          </thead>
          <tbody>
            {result.timeline.map((point) => (
              <tr key={point.year} className="border-t">
                <td className="px-3 py-2.5 tabular-nums">{point.year}</td>
                <td className="px-3 py-2.5 tabular-nums">
                  {formatYuanAsWan(point.cumulative)} 萬
                </td>
                <td className="px-3 py-2.5 tabular-nums text-teal">
                  {formatWan(point.coveragePercent, 0)}%
                </td>
                <td className="px-3 py-2.5 text-muted-foreground">
                  {point.isTargetYear && point.targetMonth
                    ? `達標於 ${formatYearMonth(point.year, point.targetMonth)}`
                    : "累積中"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
