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
    <main className="mx-5 w-auto px-4 pt-5 pb-8 sm:px-5 lg:px-6">
      <div className="mb-6 flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0 max-w-4xl space-y-2">
          <h1 className="gta-title text-2xl sm:text-3xl lg:text-4xl">
            彈性規劃你的購屋現金流
          </h1>
          <p className="text-sm text-muted-foreground sm:text-base lg:text-lg">
            自備款、購屋費用、房貸月付與預售分期一次看清楚，數字改了結果立刻更新。
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:shrink-0 sm:flex-wrap">
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full px-5 text-base sm:w-auto"
            onClick={handleReset}
          >
            <RotateCcw className="size-4" />
            重置
          </Button>
          <Button
            type="button"
            className="h-11 w-full px-5 text-base sm:w-auto"
            onClick={handleCopy}
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? "已複製" : "複製摘要"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-6 md:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)] xl:grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(22rem,30rem)_minmax(0,1fr)]">
        <Card className="h-fit shadow-none md:sticky md:top-[5.5rem]">
          <CardHeader className="px-4 sm:px-6">
            <CardTitle className="text-lg sm:text-xl">規劃條件</CardTitle>
            <CardDescription className="text-sm sm:text-base">
              金額單位為萬元，全部可即時修改
            </CardDescription>
          </CardHeader>
          <CardContent className="px-4 sm:px-6">
            <PlannerForm value={input} onChange={setInput} />
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card className="shadow-none">
            <CardContent className="px-4 pt-5 sm:px-6 sm:pt-6">
              <PlannerResults result={result} />
            </CardContent>
          </Card>

          {input.isPresale ? (
            <Card className="shadow-none">
              <CardContent className="px-4 pt-5 sm:px-6 sm:pt-6">
                <PresaleStages
                  input={input}
                  result={result}
                  onChange={setInput}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card className="shadow-none">
            <CardContent className="px-4 pt-5 sm:px-6 sm:pt-6">
              <TimelineView result={result} />
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardContent className="px-4 sm:px-6">
              <AiDiagnosis
                key={JSON.stringify(input)}
                input={input}
                result={result}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Separator className="my-8 bg-[var(--studio-line)] sm:my-10" />
      <p className="px-2 pb-4 text-center text-sm text-muted-foreground">
        本工具僅供個人財務規劃參考，預售期款日期未自訂時為推估，不構成投資、貸款或購屋建議。
      </p>
    </main>
  );
}
