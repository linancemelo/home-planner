"use client";

import { useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  Info,
  Lightbulb,
  Loader2,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type {
  DiagnosisResult,
  DiagnosisSectionType,
  PlannerInputWan,
  PlannerResult,
} from "@/lib/types";
import { isStaticExport, withBasePath } from "@/lib/paths";

interface AiDiagnosisProps {
  input: PlannerInputWan;
  result: PlannerResult;
}

const STATIC_API_HINT =
  "GitHub Pages 為靜態站，暫不支援 AI 診斷。請本機執行 npm run dev 使用。";

export function AiDiagnosis({ input, result }: AiDiagnosisProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnosis, setDiagnosis] = useState<DiagnosisResult | null>(null);
  const [open, setOpen] = useState(true);

  async function handleDiagnose() {
    if (isStaticExport()) {
      setError(STATIC_API_HINT);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch(withBasePath("/api/diagnose"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input, result }),
      });

      const raw = await res.text();
      let data: { diagnosis?: DiagnosisResult; error?: string } = {};
      try {
        data = JSON.parse(raw) as typeof data;
      } catch {
        throw new Error(
          res.ok ? "診斷內容格式錯誤，請稍後再試" : STATIC_API_HINT
        );
      }

      if (!res.ok) {
        throw new Error(data.error || "診斷失敗，請稍後再試");
      }

      if (!data.diagnosis) {
        throw new Error("診斷內容格式錯誤，請稍後再試");
      }
      setDiagnosis(data.diagnosis);
      setOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "診斷失敗，請稍後再試");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant="outline"
        className="w-full sm:w-auto"
        onClick={handleDiagnose}
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Sparkles className="size-4" />
        )}
        {loading ? "AI 診斷中…" : "請 AI 幫我診斷這個規劃"}
      </Button>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {diagnosis ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="rounded-xl border bg-card shadow-xs">
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Sparkles className="size-4 text-primary" />
                AI 診斷結果
              </span>
              <ChevronDown
                className={`size-4 text-muted-foreground transition-transform ${
                  open ? "rotate-180" : ""
                }`}
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t">
              <div className="space-y-4 p-4 sm:p-5">
                <div className="rounded-xl border border-indigo/20 bg-linear-to-r from-indigo/10 to-teal/8 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold text-indigo-foreground">
                    <Sparkles className="size-3.5" />
                    整體評估
                  </p>
                  <p className="mt-2 text-sm leading-7 text-foreground">
                    {diagnosis.overview}
                  </p>
                </div>

                <div className="grid gap-3 lg:grid-cols-3">
                  {diagnosis.sections.map((section) => {
                    const meta = SECTION_STYLES[section.type];
                    const Icon = meta.icon;

                    return (
                      <section
                        key={section.type}
                        className={`rounded-xl border p-4 ${meta.card}`}
                      >
                        <h3
                          className={`flex items-center gap-2 text-sm font-semibold ${meta.heading}`}
                        >
                          <span
                            className={`grid size-7 place-items-center rounded-lg ${meta.iconBox}`}
                          >
                            <Icon className="size-4" />
                          </span>
                          {section.title}
                        </h3>
                        <ul className="mt-3 space-y-3">
                          {section.items.map((item, index) => (
                            <li
                              key={`${section.type}-${index}`}
                              className="flex gap-2 text-sm leading-6 text-foreground/90"
                            >
                              <span
                                className={`mt-2 size-1.5 shrink-0 rounded-full ${meta.dot}`}
                              />
                              <span>{item}</span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    );
                  })}
                </div>

                <p className="flex gap-2 rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {diagnosis.disclaimer}
                </p>
              </div>
            </CollapsibleContent>
          </div>
        </Collapsible>
      ) : null}
    </div>
  );
}

const SECTION_STYLES: Record<
  DiagnosisSectionType,
  {
    icon: typeof CheckCircle2;
    card: string;
    heading: string;
    iconBox: string;
    dot: string;
  }
> = {
  advantages: {
    icon: CheckCircle2,
    card: "border-teal/25 bg-teal/5",
    heading: "text-teal-foreground",
    iconBox: "bg-teal/15 text-teal",
    dot: "bg-teal",
  },
  risks: {
    icon: ShieldAlert,
    card: "border-amber/30 bg-amber/8",
    heading: "text-amber-foreground",
    iconBox: "bg-amber/20 text-amber-foreground",
    dot: "bg-amber",
  },
  suggestions: {
    icon: Lightbulb,
    card: "border-indigo/25 bg-indigo/5",
    heading: "text-indigo-foreground",
    iconBox: "bg-indigo/15 text-indigo",
    dot: "bg-indigo",
  },
};
