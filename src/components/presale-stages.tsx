"use client";

import { CheckCircle2, Landmark, Wallet } from "lucide-react";
import { formatPercent, formatYearMonth, formatYuanAsWan } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlannerInputWan, PlannerResult, PresaleStage } from "@/lib/types";

/** 以「實際存滿的月份」描述本期進度，而非只看期款到期日 */
function describeStageTiming(stage: PresaleStage): {
  text: string;
  className: string;
} {
  const shortfallAtDue = Math.max(
    0,
    stage.cumulativeRequired - stage.projectedCashAtDue
  );

  if (stage.readyMonths === null) {
    return {
      text: `每月未新增儲蓄，到期仍缺 ${formatYuanAsWan(shortfallAtDue)} 萬`,
      className: "text-amber-foreground",
    };
  }

  if (stage.readyMonths === 0) {
    return {
      text: "目前現金就足夠付到這一期",
      className: "text-teal-foreground",
    };
  }

  const readyLabel = formatYearMonth(stage.readyYear!, stage.readyMonth!);
  const ahead = stage.monthsAheadOfDue ?? 0;

  if (ahead > 0) {
    return {
      text: `預估 ${readyLabel} 就存滿，比期款日早 ${ahead} 個月`,
      className: "text-teal-foreground",
    };
  }

  if (ahead === 0) {
    return {
      text: `預估 ${readyLabel} 存滿，剛好趕上期款日`,
      className: "text-muted-foreground",
    };
  }

  return {
    text: `預估要到 ${readyLabel} 才存滿，比期款日晚 ${-ahead} 個月（到期仍缺 ${formatYuanAsWan(
      shortfallAtDue
    )} 萬）`,
    className: "text-amber-foreground",
  };
}

interface PresaleStagesProps {
  input: PlannerInputWan;
  result: PlannerResult;
}

export function PresaleStages({ input, result }: PresaleStagesProps) {
  if (!input.isPresale || !result.presaleStages?.length) {
    return null;
  }

  const totalStageCash = result.presaleStages.reduce(
    (sum, s) => sum + s.totalCash,
    0
  );
  const reachedCount = result.presaleStages.filter((s) => s.reachedNow).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            預售屋分階段付款
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            依初期自備比例拆成常見工程期款；目前資金會依簽約到交屋的順序分配。時程為示意，實際以合約為準。
          </p>
        </div>
        <p className="text-xs text-muted-foreground sm:text-right">
          目前已備妥 {reachedCount}／{result.presaleStages.length} 期
        </p>
      </div>

      <div className="grid gap-3">
        {result.presaleStages.map((stage, index) => {
          const coverageDisplay = Math.min(stage.coverageNow, 100);
          const timing = describeStageTiming(stage);

          return (
            <div
              key={stage.id}
              className={cn(
                "rounded-xl border bg-card p-4 shadow-xs",
                stage.reachedNow ? "border-teal/30" : "border-indigo/20"
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      stage.reachedNow
                        ? "bg-teal/15 text-teal"
                        : "bg-indigo/15 text-indigo"
                    )}
                  >
                    {stage.reachedNow ? (
                      <CheckCircle2 className="size-4" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="font-medium">{stage.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {stage.hint}・約{" "}
                      {formatYearMonth(stage.dueYear, stage.dueMonth)}
                    </p>
                    {stage.extraFees.length > 0 ? (
                      <p className="mt-1 text-xs text-amber-foreground">
                        含 {stage.extraFees.map((f) => f.label).join("、")}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="sm:text-right">
                  <p className="text-lg font-semibold tabular-nums text-indigo">
                    {formatYuanAsWan(stage.totalCash)} 萬
                  </p>
                  <p className="text-xs text-muted-foreground">
                    房屋自備 {formatYuanAsWan(stage.houseCash)} 萬・約總價{" "}
                    {formatPercent(stage.ofHousePriceRatio, 1)}
                  </p>
                </div>
              </div>

              <div className="mt-3 space-y-2 rounded-lg bg-muted/30 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      stage.reachedNow
                        ? "bg-teal/15 text-teal-foreground"
                        : "bg-amber/20 text-amber-foreground"
                    )}
                  >
                    {stage.reachedNow
                      ? "目前已達標"
                      : `目前尚缺 ${formatYuanAsWan(stage.remainingNow)} 萬`}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    已備 {formatYuanAsWan(stage.fundedNow)} 萬／
                    {formatYuanAsWan(stage.totalCash)} 萬
                  </span>
                </div>
                <div
                  className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-valuenow={Math.round(coverageDisplay)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${stage.title}目前達標進度`}
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      stage.reachedNow
                        ? "bg-teal"
                        : "bg-linear-to-r from-amber to-indigo"
                    )}
                    style={{ width: `${coverageDisplay}%` }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  截至本期累積需 {formatYuanAsWan(stage.cumulativeRequired)} 萬・
                  <span className={timing.className}>{timing.text}</span>
                </p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-3 rounded-xl border bg-teal/8 p-4">
          <Wallet className="mt-0.5 size-4 shrink-0 text-teal" />
          <div>
            <p className="text-xs text-muted-foreground">分期現金合計</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatYuanAsWan(totalStageCash)} 萬
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4">
          <Landmark className="mt-0.5 size-4 shrink-0 text-indigo" />
          <div>
            <p className="text-xs text-muted-foreground">交屋時銀行貸款對撥（示意）</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatYuanAsWan(result.estimatedLoan)} 萬
            </p>
            <p className="text-xs text-muted-foreground">
              此筆通常不是自備現金，而是銀行撥付給建商
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
