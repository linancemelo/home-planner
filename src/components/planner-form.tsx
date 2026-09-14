"use client";

import { useEffect, useRef, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { maxGracePeriodYears, resolveFeesWan } from "@/lib/calculations";
import { MAX_GRACE_PERIOD_YEARS, MAX_LOAN_TERM_YEARS } from "@/lib/defaults";
import { formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PlannerInputWan } from "@/lib/types";

interface PlannerFormProps {
  value: PlannerInputWan;
  onChange: (next: PlannerInputWan) => void;
}

export function PlannerForm({ value, onChange }: PlannerFormProps) {
  const fees = resolveFeesWan(value);

  const update = <K extends keyof PlannerInputWan>(
    key: K,
    next: PlannerInputWan[K]
  ) => {
    onChange({ ...value, [key]: next });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-xl border-2 border-indigo/40 bg-indigo/10 p-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold">這是預售屋嗎？</p>
          <p className="text-xs text-muted-foreground">
            預售屋會改用初期自備比例，並列出簽約到交屋的分期現金
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {[
            { label: "成屋／中古屋", presale: false },
            { label: "預售屋", presale: true },
          ].map((option) => {
            const active = value.isPresale === option.presale;
            return (
              <button
                key={option.label}
                type="button"
                aria-pressed={active}
                onClick={() => update("isPresale", option.presale)}
                className={cn(
                  "rounded-xl border px-3 py-3 text-sm font-semibold transition-colors",
                  active
                    ? "border-indigo bg-indigo text-primary-foreground shadow-sm"
                    : "border-border bg-background/80 text-muted-foreground hover:border-indigo/40 hover:bg-background"
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>

        {value.isPresale ? (
          <PercentField
            id="initialRatio"
            label="初期自備比例"
            min={1}
            max={50}
            value={Math.round(value.initialSelfFundRatio * 100)}
            onValueChange={(pct) => update("initialSelfFundRatio", pct / 100)}
          />
        ) : null}
      </div>

      <Section title="購屋條件">
        <Field label="房屋總價（萬元）" htmlFor="housePrice" hint="預設 1,500">
          <NumericInput
            id="housePrice"
            min={0}
            step={10}
            value={value.housePriceWan}
            onValueChange={(n) => update("housePriceWan", n)}
          />
        </Field>

        <div className="space-y-3">
          <PercentField
            id="loanRatio"
            label="貸款成數"
            min={0}
            max={90}
            value={Math.round(value.loanRatio * 100)}
            onValueChange={(pct) => update("loanRatio", pct / 100)}
          />
          <p className="text-xs text-muted-foreground">
            {value.isPresale
              ? "預售屋以初期比例估算備款目標，房貸仍依此成數於交屋對撥"
              : `自備約 ${formatPercent(1 - value.loanRatio, 0)}`}
          </p>
        </div>
      </Section>

      <Section title="房貸條件" tone="indigo">
        <p className="-mt-1 text-xs text-muted-foreground">
          本息平均攤還；寬限期內只繳利息，本金在剩餘年限攤還
        </p>
        <div className="grid grid-cols-1 gap-4">
          <Field
            label="年利率（%）"
            htmlFor="annualInterestRate"
          >
            <NumericInput
              id="annualInterestRate"
              min={0}
              max={100}
              step={0.01}
              value={value.annualInterestRate}
              onValueChange={(n) => update("annualInterestRate", n)}
            />
          </Field>
          <Field
            label="貸款年限（年）"
            htmlFor="loanTermYears"
            hint={`最多 ${MAX_LOAN_TERM_YEARS} 年`}
          >
            <NumericInput
              id="loanTermYears"
              integer
              min={1}
              max={MAX_LOAN_TERM_YEARS}
              step={1}
              value={value.loanTermYears}
              onValueChange={(n) => {
                onChange({
                  ...value,
                  loanTermYears: n,
                  gracePeriodYears: Math.min(
                    value.gracePeriodYears,
                    maxGracePeriodYears(n)
                  ),
                });
              }}
            />
          </Field>
          <Field
            label="寬限期（年）"
            htmlFor="gracePeriodYears"
          >
            <select
              id="gracePeriodYears"
              value={Math.min(
                value.gracePeriodYears,
                maxGracePeriodYears(value.loanTermYears)
              )}
              onChange={(e) =>
                update("gracePeriodYears", Number(e.target.value))
              }
              className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"
            >
              {Array.from({ length: MAX_GRACE_PERIOD_YEARS + 1 }, (_, year) => {
                const disabled = year > maxGracePeriodYears(value.loanTermYears);
                return (
                  <option key={year} value={year} disabled={disabled}>
                    {year === 0 ? "不使用寬限期" : `${year} 年`}
                  </option>
                );
              })}
            </select>
          </Field>
        </div>
      </Section>

      <Section title="儲蓄節奏">
        <Field
          label="目前可動用自備款（萬元）"
          htmlFor="currentDown"
        >
          <NumericInput
            id="currentDown"
            min={0}
            step={1}
            value={value.currentDownPaymentWan}
            onValueChange={(n) => update("currentDownPaymentWan", n)}
          />
        </Field>

        <Field label="每月可新增（萬元）" htmlFor="monthlySave">
          <NumericInput
            id="monthlySave"
            min={0}
            step={0.1}
            value={value.monthlySaveWan}
            onValueChange={(n) => update("monthlySaveWan", n)}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="開始年份" htmlFor="startYear">
            <NumericInput
              id="startYear"
              integer
              min={2000}
              max={2100}
              step={1}
              value={value.startYear}
              onValueChange={(n) => update("startYear", n)}
            />
          </Field>
          <Field label="開始月份" htmlFor="startMonth">
            <NumericInput
              id="startMonth"
              integer
              min={1}
              max={12}
              step={1}
              value={value.startMonth}
              onValueChange={(n) => update("startMonth", n)}
            />
          </Field>
        </div>
      </Section>

      <Section title="額外費用（選填，萬元）" tone="amber">
        <p className="-mt-1 text-xs text-muted-foreground">
          代書費與仲介費會依房屋總價自動試算，可直接改成實際金額
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="代書費"
            htmlFor="notaryFee"
            auto={value.notaryFeeWan === null}
            onResetAuto={() => update("notaryFeeWan", null)}
            hint="約總價 0.1%"
          >
            <NumericInput
              id="notaryFee"
              min={0}
              step={0.1}
              value={fees.notaryFeeWan}
              onValueChange={(n) => update("notaryFeeWan", n)}
            />
          </Field>
          <Field
            label="仲介費"
            htmlFor="agencyFee"
            auto={value.agencyFeeWan === null}
            onResetAuto={() => update("agencyFeeWan", null)}
            hint={value.isPresale ? "預售建商直售為 0" : "買方約 1%"}
          >
            <NumericInput
              id="agencyFee"
              min={0}
              step={0.1}
              value={fees.agencyFeeWan}
              onValueChange={(n) => update("agencyFeeWan", n)}
            />
          </Field>
          <Field label="裝潢費" htmlFor="decorationFee">
            <NumericInput
              id="decorationFee"
              min={0}
              step={1}
              value={value.decorationFeeWan}
              onValueChange={(n) => update("decorationFeeWan", n)}
            />
          </Field>
          <Field label="其他雜費" htmlFor="otherFee" hint="契稅／火險等">
            <NumericInput
              id="otherFee"
              min={0}
              step={0.1}
              value={value.otherFeeWan}
              onValueChange={(n) => update("otherFeeWan", n)}
            />
          </Field>
        </div>
      </Section>
    </div>
  );
}

function PercentField({
  id,
  label,
  min,
  max,
  value,
  onValueChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  value: number;
  onValueChange: (next: number) => void;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="leading-snug">
          {label}
        </Label>
        <span className="text-sm font-medium leading-snug tabular-nums text-teal">
          {formatPercent(value / 100, 0)}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <RangeSlider
          id={id}
          min={min}
          max={max}
          value={value}
          onValueChange={onValueChange}
        />
        <div className="w-16 shrink-0">
          <NumericInput
            id={`${id}Pct`}
            integer
            min={min}
            max={max}
            step={1}
            value={value}
            onValueChange={onValueChange}
          />
        </div>
      </div>
    </div>
  );
}

function RangeSlider({
  id,
  value,
  min,
  max,
  onValueChange,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  onValueChange: (next: number) => void;
}) {
  return (
    <input
      id={id}
      type="range"
      min={min}
      max={max}
      step={1}
      value={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      onChange={(e) => onValueChange(Number(e.target.value))}
      className="h-8 w-full min-w-0 flex-1 cursor-grab accent-teal active:cursor-grabbing"
    />
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "amber" | "indigo";
}) {
  return (
    <div
      className={
        tone === "amber"
          ? "space-y-4 rounded-xl border border-amber/30 bg-amber/10 p-4"
          : tone === "indigo"
            ? "space-y-4 rounded-xl border border-indigo/25 bg-indigo/5 p-4"
          : "space-y-4 rounded-xl border border-border/80 bg-muted/20 p-4"
      }
    >
      <p className="text-xs font-semibold tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  auto,
  onResetAuto,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  auto?: boolean;
  onResetAuto?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={htmlFor} className="leading-snug">
          {label}
          {auto ? (
            <span className="ml-1.5 rounded-full bg-amber/25 px-1.5 py-0.5 text-[10px] font-medium leading-none text-amber-foreground">
              自動
            </span>
          ) : null}
        </Label>
        {auto === false && onResetAuto ? (
          <button
            type="button"
            onClick={onResetAuto}
            className="shrink-0 text-xs leading-snug text-amber-foreground underline-offset-2 hover:underline"
          >
            回自動試算
          </button>
        ) : hint ? (
          <span className="shrink-0 text-xs leading-snug text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function NumericInput({
  id,
  value,
  onValueChange,
  min,
  max,
  step,
  integer,
}: {
  id: string;
  value: number;
  onValueChange: (next: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
}) {
  const focusedRef = useRef(false);
  const [text, setText] = useState(() => formatNumericText(value));

  useEffect(() => {
    if (focusedRef.current && text === "" && value === 0) return;
    if (
      focusedRef.current &&
      text !== "" &&
      parseNumericText(text, integer) === value
    ) {
      return;
    }
    const next = formatNumericText(value);
    if (next !== text) setText(next);
  }, [integer, text, value]);

  return (
    <Input
      id={id}
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      min={min}
      max={max}
      step={step}
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        const next = clampNumeric(parseNumericText(text, integer), min, max);
        setText(formatNumericText(next));
        onValueChange(next);
      }}
      onChange={(e) => {
        const nextText = sanitizeNumericDraft(e.target.value, integer);
        setText(nextText);
        const parsed = parseNumericText(nextText, integer);
        onValueChange(max != null && parsed > max ? max : parsed);
      }}
    />
  );
}

function formatNumericText(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(value);
}

function sanitizeNumericDraft(raw: string, integer?: boolean): string {
  let s = raw.replace(/,/g, "").replace(/[^\d.]/g, "");
  if (integer) {
    s = s.replace(/\./g, "");
  } else {
    const dot = s.indexOf(".");
    if (dot !== -1) {
      s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, "")}`;
    }
  }

  if (s === "") return "";
  if (s === ".") return "0.";

  const hasDot = !integer && s.includes(".");
  const [intRaw, decRaw = ""] = s.split(".");
  const intPart = intRaw.replace(/^0+(?=\d)/, "");

  if (hasDot) {
    return `${intPart || "0"}.${decRaw}`;
  }
  return intPart;
}

function parseNumericText(raw: string, integer?: boolean): number {
  if (raw.trim() === "" || raw === ".") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return integer ? Math.trunc(n) : n;
}

function clampNumeric(value: number, min?: number, max?: number): number {
  let next = value;
  if (min != null) next = Math.max(min, next);
  if (max != null) next = Math.min(max, next);
  return next;
}
