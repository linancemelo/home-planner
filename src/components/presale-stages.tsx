"use client";

import { CheckCircle2, Landmark, RotateCcw, Wallet } from "lucide-react";
import { GlassSelect } from "@/components/ui/glass-select";
import { PRESALE_DEFAULT_BUILD_MONTHS } from "@/lib/defaults";
import { formatPercent, formatYearMonth, formatYuanAsWan } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  PlannerInputWan,
  PlannerResult,
  PresaleStage,
  PresaleStageId,
  YearMonth,
} from "@/lib/types";

function MonthPicker({
  id,
  label,
  value,
  anchorYear,
  onChange,
}: {
  id: string;
  label: string;
  value: YearMonth;
  anchorYear: number;
  onChange: (next: YearMonth) => void;
}) {
  const firstYear = Math.min(anchorYear - 1, value.year);
  const lastYear = Math.max(anchorYear + 8, value.year);
  const years = Array.from(
    { length: lastYear - firstYear + 1 },
    (_, i) => firstYear + i
  );

  return (
    <div role="group" aria-label={label} className="flex items-center gap-1">
      <GlassSelect
        id={`${id}-year`}
        ariaLabel={`${label}（年）`}
        className="w-[7.5rem]"
        value={value.year}
        onChange={(next) => onChange({ year: Number(next), month: value.month })}
        options={years.map((year) => ({ value: year, label: `${year} 年` }))}
      />
      <GlassSelect
        id={`${id}-month`}
        ariaLabel={`${label}（月）`}
        className="w-[6.5rem]"
        value={value.month}
        onChange={(next) => onChange({ year: value.year, month: Number(next) })}
        options={Array.from({ length: 12 }, (_, i) => ({
          value: i + 1,
          label: `${i + 1} 月`,
        }))}
      />
    </div>
  );
}

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
  onChange: (next: PlannerInputWan) => void;
}

export function PresaleStages({ input, result, onChange }: PresaleStagesProps) {
  if (!input.isPresale || !result.presaleStages?.length) {
    return null;
  }

  const stages = result.presaleStages;
  const totalStageCash = stages.reduce((sum, s) => sum + s.totalCash, 0);
  const reachedCount = stages.filter((s) => s.reachedNow).length;
  const hasCustomDate = stages.some((s) => s.isCustomDate);

  function setDueDate(id: PresaleStageId, date: YearMonth | null) {
    const next = { ...input.presaleDueDates };
    if (date) next[id] = date;
    else delete next[id];
    onChange({ ...input, presaleDueDates: next });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="gta-title text-lg">
            預售屋分階段付款
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            依初期自備比例拆成常見工程期款，目前資金依簽約到交屋的順序分配。各期日期可依合約自訂；沒自訂的期別以「簽約起
            {PRESALE_DEFAULT_BUILD_MONTHS / 12} 年交屋」為基準推估，若前後期有自訂則依比例調整。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
          <p className="text-xs text-muted-foreground">
            目前已備妥 {reachedCount}／{stages.length} 期
          </p>
          {hasCustomDate ? (
            <button
              type="button"
              onClick={() => onChange({ ...input, presaleDueDates: {} })}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              <RotateCcw className="size-3" />
              日期全部回預設
            </button>
          ) : null}
        </div>
      </div>

      <div className="grid gap-3">
        {stages.map((stage, index) => {
          const coverageDisplay = Math.min(stage.coverageNow, 100);
          const timing = describeStageTiming(stage);
          const outOfOrder =
            index > 0 && stage.offsetMonths < stages[index - 1].offsetMonths;

          return (
            <div
              key={stage.id}
              className={cn(
                "rounded-2xl border bg-white/[0.04] p-4",
                stage.reachedNow ? "border-[var(--gta-green)]/40" : "border-white/10"
              )}
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
                      stage.reachedNow
                        ? "bg-teal/15 text-teal"
                        : "bg-white/10 text-white"
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
                      {stage.hint}
                    </p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <MonthPicker
                        id={`presale-due-${stage.id}`}
                        label={`${stage.title}到期年月`}
                        value={{ year: stage.dueYear, month: stage.dueMonth }}
                        anchorYear={input.startYear}
                        onChange={(date) => setDueDate(stage.id, date)}
                      />
                      {stage.isCustomDate ? (
                        <>
                          <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-accent-foreground">
                            自訂
                          </span>
                          <button
                            type="button"
                            onClick={() => setDueDate(stage.id, null)}
                            className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                          >
                            回預設
                          </button>
                        </>
                      ) : (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                          推估
                        </span>
                      )}
                    </div>
                    {outOfOrder ? (
                      <p className="mt-1 text-xs text-destructive">
                        日期早於上一期，請確認合約時程
                      </p>
                    ) : null}
                    {stage.extraFees.length > 0 ? (
                      <p className="mt-1 text-xs text-amber-foreground">
                        含 {stage.extraFees.map((f) => f.label).join("、")}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="sm:text-right">
                  <p className="gta-num text-2xl text-[var(--gta-gold)]">
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
                        : "bg-white"
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
        <div className="flex items-start gap-3 rounded-2xl border border-[var(--gta-green)]/30 bg-[var(--gta-green)]/10 p-4">
          <Wallet className="mt-0.5 size-4 shrink-0 text-teal" />
          <div>
            <p className="text-xs text-muted-foreground">分期現金合計</p>
            <p className="text-lg font-semibold tabular-nums">
              {formatYuanAsWan(totalStageCash)} 萬
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <Landmark className="mt-0.5 size-4 shrink-0 text-[var(--gta-gold)]" />
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
