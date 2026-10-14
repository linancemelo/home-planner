"use client";

import { CalendarClock, CircleDollarSign, Landmark, ReceiptText } from "lucide-react";
import {
  formatPercent,
  formatWan,
  formatYearMonth,
  formatYuanAsWan,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlannerResult } from "@/lib/types";

interface PlannerResultsProps {
  result: PlannerResult;
}

export function PlannerResults({ result }: PlannerResultsProps) {
  const coverageDisplay = Math.min(result.coveragePercent, 100);

  let statusLabel = "規劃中";
  let statusClass = "bg-secondary text-secondary-foreground";

  if (result.alreadyReached) {
    statusLabel = "已達標";
    statusClass = "bg-white text-[#1a1e27]";
  } else if (result.unreachable) {
    statusLabel = "無法估計";
    statusClass = "bg-white/10 text-[#e4b7b1]";
  } else {
    statusLabel = "累積中";
    statusClass = "border border-white/25 bg-white/10 text-white";
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="gta-title text-lg">即時計算結果</h2>
        <span
          className={cn(
            "inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium",
            statusClass
          )}
        >
          {statusLabel}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="需準備現金合計"
          value={`${formatYuanAsWan(result.requiredDownPayment)} 萬`}
          hint={`房屋自備 ${formatYuanAsWan(result.houseCashRequired)} 萬`}
          tone="teal"
        />
        <StatCard
          label="目前自備款"
          value={`${formatYuanAsWan(result.currentDownPayment)} 萬`}
        />
        <StatCard
          label="資金缺口"
          value={`${formatYuanAsWan(result.gap)} 萬`}
          emphasize={result.gap > 0}
          tone="amber"
        />
        <StatCard
          label="預估達標時間"
          value={
            result.alreadyReached
              ? "現在即可"
              : result.unreachable
                ? "—"
                : formatYearMonth(result.targetYear!, result.targetMonth!)
          }
          hint={
            result.monthsNeeded === null
              ? "請提高每月新增金額"
              : result.monthsNeeded === 0
                ? "無需再等"
                : `約需 ${result.monthsNeeded} 個月`
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <MiniStat
          label="額外費用合計"
          value={`${formatYuanAsWan(result.extraFeesTotal)} 萬`}
        />
        <MiniStat
          label="預估貸款對撥"
          value={`${formatYuanAsWan(result.estimatedLoan)} 萬`}
          hint={`房屋自備約總價 ${formatPercent(result.effectiveSelfFundRatio, 0)}`}
        />
      </div>

      <section className="overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04]">
        <div className="space-y-3 border-b border-white/10 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="gta-title flex items-center gap-2 text-base">
              <Landmark className="size-4 text-[var(--gta-gold)]" />
              房貸月付試算
            </h3>
            <div className="flex flex-wrap gap-1.5">
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs whitespace-nowrap text-white">
                年利率 {formatWan(result.annualInterestRate, 3)}%
              </span>
              <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs whitespace-nowrap text-white">
                {result.loanTermYears} 年
              </span>
              {result.gracePeriodYears > 0 ? (
                <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs whitespace-nowrap text-white">
                  寬限 {result.gracePeriodYears} 年
                </span>
              ) : null}
            </div>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {result.gracePeriodYears > 0
              ? `以貸款對撥 ${formatYuanAsWan(result.estimatedLoan)} 萬試算；寬限 ${result.gracePeriodYears} 年只繳息，之後 ${result.loanTermYears - result.gracePeriodYears} 年本息攤還。代書、仲介、裝潢等是現金支出，不計入月付`
              : `以貸款對撥 ${formatYuanAsWan(result.estimatedLoan)} 萬試算，本息平均攤還。代書、仲介、裝潢等是現金支出，不計入月付`}
          </p>
        </div>

        <div
          className={cn(
            "grid gap-px bg-border/60 sm:grid-cols-2",
            result.gracePeriodYears > 0 ? "xl:grid-cols-3" : "xl:grid-cols-4"
          )}
        >
          {result.gracePeriodYears > 0 ? (
            <>
              <LoanStat
                icon={CircleDollarSign}
                label={`寬限期月付（前 ${result.gracePeriodYears} 年）`}
                value={`${formatWan(result.monthlyPaymentDuringGrace, 0)} 元`}
                hint="只繳利息、不還本金"
                emphasize
              />
              <LoanStat
                icon={CircleDollarSign}
                label={`攤還期月付（後 ${result.loanTermYears - result.gracePeriodYears} 年）`}
                value={`${formatWan(result.monthlyPaymentAfterGrace, 0)} 元`}
                hint="本金＋利息"
                emphasize
              />
            </>
          ) : (
            <LoanStat
              icon={CircleDollarSign}
              label="每月還款"
              value={`${formatWan(result.monthlyMortgagePayment, 0)} 元`}
              emphasize
            />
          )}
          <LoanStat
            icon={ReceiptText}
            label="利息總額"
            value={`${formatYuanAsWan(result.totalMortgageInterest)} 萬`}
          />
          <LoanStat
            icon={CalendarClock}
            label="本息總還款"
            value={`${formatYuanAsWan(result.totalMortgagePayment)} 萬`}
          />
          {result.gracePeriodYears > 0 ? (
            <LoanStat
              icon={Landmark}
              label="攤還期首月本金／利息"
              value={`${formatWan(result.afterGraceFirstMonthPrincipal, 0)}／${formatWan(
                result.afterGraceFirstMonthInterest,
                0
              )} 元`}
            />
          ) : (
            <LoanStat
              icon={Landmark}
              label="首月本金／利息"
              value={`${formatWan(result.firstMonthPrincipal, 0)}／${formatWan(
                result.firstMonthInterest,
                0
              )} 元`}
            />
          )}
        </div>
      </section>

      {result.extraFeeItems.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {result.extraFeeItems.map((item) => (
            <span
              key={item.id}
              className="rounded-full bg-amber/15 px-2.5 py-1 text-xs text-amber-foreground"
            >
              {item.label} {formatYuanAsWan(item.amount)} 萬
            </span>
          ))}
        </div>
      ) : null}

      <div className="space-y-3 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <div className="mb-1 flex w-full items-center justify-between gap-2">
          <span className="text-sm font-medium">資金覆蓋率</span>
          <span className="text-sm tabular-nums text-teal">
            {formatWan(result.coveragePercent, 1)}%
          </span>
        </div>
        <div
          className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={Math.round(coverageDisplay)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="資金覆蓋率"
        >
          <div
            className="h-full rounded-full bg-white transition-[width]"
            style={{ width: `${coverageDisplay}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          以目前現金相對「房屋自備＋額外費用」計算（可超過 100%）
        </p>
      </div>
    </div>
  );
}

function LoanStat({
  icon: Icon,
  label,
  value,
  hint,
  emphasize,
}: {
  icon: typeof Landmark;
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
}) {
  return (
    <div className="bg-card/80 p-4">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p
        className={cn(
          "gta-num mt-1 whitespace-nowrap text-xl",
          emphasize && "text-2xl text-[var(--gta-gold)]"
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  emphasize,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasize?: boolean;
  tone?: "teal" | "amber";
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/10 bg-white/[0.04] p-4",
        tone === "teal" && "border-teal/25",
        tone === "amber" && "border-amber/30",
        emphasize && "border-destructive/40"
      )}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={cn(
          "gta-num mt-1 whitespace-nowrap text-2xl",
          emphasize && "text-destructive",
          tone === "teal" && !emphasize && "text-teal",
          tone === "amber" && !emphasize && "text-amber-foreground"
        )}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function MiniStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="gta-num mt-0.5 text-xl">{value}</p>
      {hint ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
