"use client";

import { useMemo, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { AiDiagnosis } from "@/components/ai-diagnosis";
import { PlannerForm } from "@/components/planner-form";
import { PlannerResults } from "@/components/planner-results";
import { PresaleStages } from "@/components/presale-stages";
import { TimelineView } from "@/components/timeline-view";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { buildSummaryText, calculatePlanner } from "@/lib/calculations";
import { DEFAULT_PLANNER_INPUT } from "@/lib/defaults";
import type { PlannerInputWan } from "@/lib/types";

export function HomePlannerApp() {
  const [input, setInput] = useState<PlannerInputWan>(DEFAULT_PLANNER_INPUT);
  const [copied, setCopied] = useState(false);

  const result = useMemo(() => calculatePlanner(input), [input]);

  async function handleCopy() {
    const text = buildSummaryText(input, result);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard errors
    }
  }

  function handleReset() {
    setInput({ ...DEFAULT_PLANNER_INPUT });
  }

  return (
    <main className="mx-auto max-w-6xl px-3 py-5 sm:px-6 sm:py-8">
        <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              彈性規劃你的購屋現金流
            </h1>
            <p className="text-sm text-muted-foreground sm:text-base">
              自備款、購屋費用、房貸月付與預售分期一次看清楚，數字改了結果立刻更新。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={handleReset}
            >
              <RotateCcw className="size-4" />
              重置
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="w-full sm:w-auto"
              onClick={handleCopy}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "已複製" : "複製摘要"}
            </Button>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
          <Card className="h-fit border-teal/15 lg:sticky lg:top-20">
            <CardHeader>
              <CardTitle>規劃條件</CardTitle>
              <CardDescription>金額單位為萬元，全部可即時修改</CardDescription>
            </CardHeader>
            <CardContent>
              <PlannerForm value={input} onChange={setInput} />
            </CardContent>
          </Card>

          <div className="min-w-0 space-y-5">
            <Card className="border-teal/15">
              <CardContent className="pt-6">
                <PlannerResults result={result} />
              </CardContent>
            </Card>

            {input.isPresale ? (
              <Card className="border-indigo/20">
                <CardContent className="pt-6">
                  <PresaleStages input={input} result={result} />
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardContent className="pt-6">
                <TimelineView result={result} />
              </CardContent>
            </Card>

            <Card className="border-amber/20">
              {/* <CardHeader>
                <CardTitle>AI 診斷</CardTitle>
              </CardHeader> */}
              <CardContent>
                <AiDiagnosis
                  key={JSON.stringify(input)}
                  input={input}
                  result={result}
                />
              </CardContent>
            </Card>
          </div>
        </div>

        <Separator className="my-8" />
        <p className="px-2 text-center text-xs text-muted-foreground">
          本工具僅供個人財務規劃參考，預售期款時程為示意，不構成投資、貸款或購屋建議。
        </p>
    </main>
  );
}
