import {
  AGENCY_FEE_RATE,
  MAX_GRACE_PERIOD_YEARS,
  MAX_LOAN_TERM_YEARS,
  NOTARY_FEE_MAX_WAN,
  NOTARY_FEE_MIN_WAN,
  NOTARY_FEE_RATE,
  PRESALE_STAGE_DEFS,
  WAN_TO_YUAN,
} from "./defaults";
import { formatWan, formatYearMonth, yuanToWan } from "./format";
import { SITE_NAME } from "./site";
import type {
  ExtraFeeItem,
  PlannerInput,
  PlannerInputWan,
  PlannerResult,
  PresaleDueDates,
  PresaleStage,
  PresaleStageId,
  YearMonth,
  YearTimelinePoint,
} from "./types";

/** 依房屋總價試算代書費（萬元） */
export function suggestNotaryFeeWan(housePriceWan: number): number {
  const raw = Math.max(0, housePriceWan) * NOTARY_FEE_RATE;
  const bounded = clamp(raw, NOTARY_FEE_MIN_WAN, NOTARY_FEE_MAX_WAN);
  return Math.round(bounded * 10) / 10;
}

/** 依房屋總價試算仲介費（萬元）；預售屋建商直售視為 0 */
export function suggestAgencyFeeWan(
  housePriceWan: number,
  isPresale: boolean
): number {
  if (isPresale) return 0;
  const raw = Math.max(0, housePriceWan) * AGENCY_FEE_RATE;
  return Math.round(raw * 10) / 10;
}

/** 把可為 null 的費用欄位換成實際採用的金額（萬元） */
export function resolveFeesWan(input: PlannerInputWan): {
  notaryFeeWan: number;
  agencyFeeWan: number;
  decorationFeeWan: number;
  otherFeeWan: number;
} {
  return {
    notaryFeeWan:
      input.notaryFeeWan ?? suggestNotaryFeeWan(input.housePriceWan),
    agencyFeeWan:
      input.agencyFeeWan ??
      suggestAgencyFeeWan(input.housePriceWan, input.isPresale),
    decorationFeeWan: Math.max(0, input.decorationFeeWan),
    otherFeeWan: Math.max(0, input.otherFeeWan),
  };
}

export function toPlannerInput(input: PlannerInputWan): PlannerInput {
  const fees = resolveFeesWan(input);

  return {
    housePrice: Math.max(0, input.housePriceWan) * WAN_TO_YUAN,
    loanRatio: clamp(input.loanRatio, 0, 1),
    annualInterestRate: clamp(input.annualInterestRate, 0, 100),
    loanTermYears: clamp(Math.trunc(input.loanTermYears), 1, MAX_LOAN_TERM_YEARS),
    gracePeriodYears: clamp(
      Math.trunc(input.gracePeriodYears),
      0,
      maxGracePeriodYears(input.loanTermYears)
    ),
    currentDownPayment: Math.max(0, input.currentDownPaymentWan) * WAN_TO_YUAN,
    monthlySave: Math.max(0, input.monthlySaveWan) * WAN_TO_YUAN,
    startYear: Math.trunc(input.startYear),
    startMonth: clampMonth(input.startMonth),
    isPresale: input.isPresale,
    initialSelfFundRatio: clamp(input.initialSelfFundRatio, 0, 1),
    presaleDueDates: sanitizePresaleDueDates(input.presaleDueDates),
    notaryFee: Math.max(0, fees.notaryFeeWan) * WAN_TO_YUAN,
    agencyFee: Math.max(0, fees.agencyFeeWan) * WAN_TO_YUAN,
    decorationFee: fees.decorationFeeWan * WAN_TO_YUAN,
    otherFee: fees.otherFeeWan * WAN_TO_YUAN,
  };
}

function sanitizePresaleDueDates(
  dates: PresaleDueDates | undefined
): PresaleDueDates {
  const result: PresaleDueDates = {};
  if (!dates) return result;
  for (const def of PRESALE_STAGE_DEFS) {
    const date = dates[def.id];
    if (
      date &&
      Number.isFinite(date.year) &&
      Number.isFinite(date.month)
    ) {
      result[def.id] = {
        year: Math.trunc(date.year),
        month: clampMonth(date.month),
      };
    }
  }
  return result;
}

export function monthsBetween(from: YearMonth, to: YearMonth): number {
  return to.year * 12 + to.month - (from.year * 12 + from.month);
}

/**
 * 各期距開始月的月數。自訂日期的期別直接採用；其餘期別夾在兩個自訂期別之間時，
 * 依 2 年工期的預設間距等比內插，之後沒有自訂期別則沿用預設間距往後推。
 */
export function resolvePresaleOffsets(
  start: YearMonth,
  dueDates: PresaleDueDates
): { id: PresaleStageId; offsetMonths: number; isCustomDate: boolean }[] {
  const custom = PRESALE_STAGE_DEFS.map((def) => {
    const date = dueDates[def.id];
    return date ? monthsBetween(start, date) : null;
  });

  return PRESALE_STAGE_DEFS.map((def, index) => {
    const own = custom[index];
    if (own !== null) {
      return { id: def.id, offsetMonths: own, isCustomDate: true };
    }

    let prevIndex = -1;
    for (let i = index - 1; i >= 0; i--) {
      if (custom[i] !== null) {
        prevIndex = i;
        break;
      }
    }
    let nextIndex = -1;
    for (let i = index + 1; i < PRESALE_STAGE_DEFS.length; i++) {
      if (custom[i] !== null) {
        nextIndex = i;
        break;
      }
    }

    const prevDefault =
      prevIndex === -1 ? 0 : PRESALE_STAGE_DEFS[prevIndex].offsetMonths;
    const prevOffset = prevIndex === -1 ? 0 : custom[prevIndex]!;

    if (nextIndex === -1) {
      return {
        id: def.id,
        offsetMonths: prevOffset + (def.offsetMonths - prevDefault),
        isCustomDate: false,
      };
    }

    const nextDefault = PRESALE_STAGE_DEFS[nextIndex].offsetMonths;
    const nextOffset = custom[nextIndex]!;
    const span = nextDefault - prevDefault;
    const ratio = span > 0 ? (def.offsetMonths - prevDefault) / span : 0;
    return {
      id: def.id,
      offsetMonths: Math.round(prevOffset + (nextOffset - prevOffset) * ratio),
      isCustomDate: false,
    };
  });
}

/** 寬限期不得吃掉整段貸款年限，且有固定上限 */
export function maxGracePeriodYears(loanTermYears: number): number {
  const years = clamp(Math.trunc(loanTermYears), 1, MAX_LOAN_TERM_YEARS);
  return Math.max(0, Math.min(MAX_GRACE_PERIOD_YEARS, years - 1));
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampMonth(month: number): number {
  if (Number.isNaN(month)) return 1;
  return Math.min(12, Math.max(1, Math.trunc(month)));
}

export function calcHouseCashRequired(input: PlannerInput): number {
  const ratio = input.isPresale
    ? input.initialSelfFundRatio
    : 1 - input.loanRatio;
  return Math.max(0, input.housePrice * ratio);
}

function amortizingMonthlyPayment(
  principal: number,
  monthlyRate: number,
  payments: number
): number {
  if (principal <= 0 || payments <= 0) return 0;
  if (monthlyRate === 0) return principal / payments;
  const factor = (1 + monthlyRate) ** payments;
  return (principal * monthlyRate * factor) / (factor - 1);
}

export function calculateMortgage(
  principal: number,
  annualInterestRate: number,
  loanTermYears: number,
  gracePeriodYears = 0
): {
  monthlyPayment: number;
  monthlyPaymentDuringGrace: number;
  monthlyPaymentAfterGrace: number;
  totalPayment: number;
  totalInterest: number;
  firstMonthPrincipal: number;
  firstMonthInterest: number;
  afterGraceFirstMonthPrincipal: number;
  afterGraceFirstMonthInterest: number;
  payments: number;
  gracePeriodYears: number;
} {
  const safePrincipal = Math.max(0, principal);
  const years = clamp(Math.trunc(loanTermYears), 1, MAX_LOAN_TERM_YEARS);
  const payments = years * 12;
  const graceYears = clamp(
    Math.trunc(gracePeriodYears),
    0,
    maxGracePeriodYears(years)
  );
  const graceMonths = graceYears * 12;
  const amortMonths = payments - graceMonths;
  const monthlyRate = clamp(annualInterestRate, 0, 100) / 100 / 12;

  const empty = {
    monthlyPayment: 0,
    monthlyPaymentDuringGrace: 0,
    monthlyPaymentAfterGrace: 0,
    totalPayment: 0,
    totalInterest: 0,
    firstMonthPrincipal: 0,
    firstMonthInterest: 0,
    afterGraceFirstMonthPrincipal: 0,
    afterGraceFirstMonthInterest: 0,
    payments,
    gracePeriodYears: graceYears,
  };

  if (safePrincipal === 0) {
    return empty;
  }

  const monthlyDuringGrace = monthlyRate === 0 ? 0 : safePrincipal * monthlyRate;
  const monthlyAfterGrace = amortizingMonthlyPayment(
    safePrincipal,
    monthlyRate,
    amortMonths
  );
  const totalPayment =
    monthlyDuringGrace * graceMonths + monthlyAfterGrace * amortMonths;
  const firstMonthInterest =
    graceMonths > 0 ? monthlyDuringGrace : safePrincipal * monthlyRate;
  const firstMonthPrincipal =
    graceMonths > 0
      ? 0
      : Math.max(0, monthlyAfterGrace - firstMonthInterest);
  const afterGraceFirstMonthInterest = safePrincipal * monthlyRate;
  const afterGraceFirstMonthPrincipal = Math.max(
    0,
    monthlyAfterGrace - afterGraceFirstMonthInterest
  );

  return {
    monthlyPayment: monthlyAfterGrace,
    monthlyPaymentDuringGrace: monthlyDuringGrace,
    monthlyPaymentAfterGrace: monthlyAfterGrace,
    totalPayment,
    totalInterest: Math.max(0, totalPayment - safePrincipal),
    firstMonthPrincipal,
    firstMonthInterest,
    afterGraceFirstMonthPrincipal,
    afterGraceFirstMonthInterest,
    payments,
    gracePeriodYears: graceYears,
  };
}

export function listExtraFees(input: PlannerInput): ExtraFeeItem[] {
  const items: ExtraFeeItem[] = [
    { id: "notary", label: "代書費", amount: input.notaryFee },
    { id: "agency", label: "仲介費", amount: input.agencyFee },
    { id: "decoration", label: "裝潢費", amount: input.decorationFee },
    { id: "other", label: "其他雜費", amount: input.otherFee },
  ];
  return items.filter((item) => item.amount > 0);
}

export function addMonths(
  year: number,
  month: number,
  monthsToAdd: number
): { year: number; month: number } {
  const zeroBased = year * 12 + (month - 1) + monthsToAdd;
  return {
    year: Math.floor(zeroBased / 12),
    month: (zeroBased % 12) + 1,
  };
}

export function buildTimeline(
  startYear: number,
  startMonth: number,
  current: number,
  monthlySave: number,
  required: number,
  monthsNeeded: number
): YearTimelinePoint[] {
  const points: YearTimelinePoint[] = [];
  const target = addMonths(startYear, startMonth, monthsNeeded);
  const endYear = Math.max(startYear, target.year);

  for (let year = startYear; year <= endYear; year++) {
    let monthsElapsed: number;
    let isTargetYear = false;
    let targetMonth: number | undefined;

    if (year < target.year) {
      monthsElapsed = (year - startYear) * 12 + (12 - startMonth + 1);
    } else {
      monthsElapsed = monthsNeeded;
      isTargetYear = true;
      targetMonth = target.month;
    }

    const cumulative = Math.min(
      required || current,
      current + monthlySave * Math.max(0, monthsElapsed)
    );
    const coveragePercent =
      required <= 0 ? 100 : (cumulative / required) * 100;

    points.push({
      year,
      cumulative,
      isTargetYear,
      targetMonth,
      coveragePercent,
    });
  }

  return points;
}

function buildPresaleStages(input: PlannerInput, houseCash: number): PresaleStage[] {
  const totalWeight = PRESALE_STAGE_DEFS.reduce((sum, s) => sum + s.weight, 0);
  const contractExtras = listExtraFees({
    ...input,
    decorationFee: 0,
  });
  const handoverExtras: ExtraFeeItem[] = [];
  if (input.decorationFee > 0) {
    handoverExtras.push({ id: "decoration", label: "裝潢費", amount: input.decorationFee });
  }

  const schedule = resolvePresaleOffsets(
    { year: input.startYear, month: input.startMonth },
    input.presaleDueDates
  );

  return PRESALE_STAGE_DEFS.map((def, defIndex) => {
    const housePart = houseCash * (def.weight / totalWeight);
    const extras =
      def.id === "contract"
        ? contractExtras
        : def.id === "handover"
          ? handoverExtras
          : [];
    const extraSum = extras.reduce((s, e) => s + e.amount, 0);

    return {
      id: def.id,
      title: def.title,
      hint: def.hint,
      ofHousePriceRatio:
        input.housePrice > 0 ? housePart / input.housePrice : 0,
      houseCash: housePart,
      extraFees: extras,
      totalCash: housePart + extraSum,
      offsetMonths: schedule[defIndex].offsetMonths,
      isCustomDate: schedule[defIndex].isCustomDate,
      cumulativeRequired: 0,
      fundedNow: 0,
      remainingNow: 0,
      reachedNow: false,
      coverageNow: 0,
      projectedCashAtDue: 0,
      fundedAtDue: 0,
      reachedAtDue: false,
      dueYear: input.startYear,
      dueMonth: input.startMonth,
      readyMonths: null,
      readyYear: null,
      readyMonth: null,
      monthsAheadOfDue: null,
    };
  }).map((stage, index, stages) => {
    const previousRequired = stages
      .slice(0, index)
      .reduce((sum, s) => sum + s.totalCash, 0);
    const cumulativeRequired = previousRequired + stage.totalCash;
    const fundedNow = Math.min(
      stage.totalCash,
      Math.max(0, input.currentDownPayment - previousRequired)
    );
    const projectedCashAtDue =
      input.currentDownPayment +
      input.monthlySave * Math.max(0, stage.offsetMonths);
    const fundedAtDue = Math.min(
      stage.totalCash,
      Math.max(0, projectedCashAtDue - previousRequired)
    );

    const shortfallNow = Math.max(0, cumulativeRequired - input.currentDownPayment);
    let readyMonths: number | null;
    if (shortfallNow <= 1e-6) {
      readyMonths = 0;
    } else if (input.monthlySave > 0) {
      readyMonths = Math.ceil(shortfallNow / input.monthlySave);
    } else {
      readyMonths = null;
    }
    const ready =
      readyMonths === null
        ? null
        : addMonths(input.startYear, input.startMonth, readyMonths);
    const due = addMonths(input.startYear, input.startMonth, stage.offsetMonths);

    return {
      ...stage,
      cumulativeRequired,
      fundedNow,
      remainingNow: Math.max(0, stage.totalCash - fundedNow),
      reachedNow: fundedNow + 1e-6 >= stage.totalCash,
      coverageNow:
        stage.totalCash <= 0 ? 100 : (fundedNow / stage.totalCash) * 100,
      projectedCashAtDue,
      fundedAtDue,
      reachedAtDue: projectedCashAtDue + 1e-6 >= cumulativeRequired,
      dueYear: due.year,
      dueMonth: due.month,
      readyMonths,
      readyYear: ready?.year ?? null,
      readyMonth: ready?.month ?? null,
      monthsAheadOfDue:
        readyMonths === null ? null : stage.offsetMonths - readyMonths,
    };
  });
}

export function calculatePlanner(raw: PlannerInputWan): PlannerResult {
  const input = toPlannerInput(raw);
  const houseCashRequired = calcHouseCashRequired(input);
  const extraFeeItems = listExtraFees(input);
  const extraFeesTotal = extraFeeItems.reduce((s, i) => s + i.amount, 0);
  const requiredDownPayment = houseCashRequired + extraFeesTotal;
  const currentDownPayment = Math.max(0, input.currentDownPayment);
  const gap = Math.max(0, requiredDownPayment - currentDownPayment);
  const coveragePercent =
    requiredDownPayment <= 0
      ? 100
      : (currentDownPayment / requiredDownPayment) * 100;

  const alreadyReached = gap <= 0;
  const effectiveSelfFundRatio = input.isPresale
    ? input.initialSelfFundRatio
    : 1 - input.loanRatio;
  const estimatedLoan = input.housePrice * input.loanRatio;
  const mortgage = calculateMortgage(
    estimatedLoan,
    input.annualInterestRate,
    input.loanTermYears,
    input.gracePeriodYears
  );
  const mortgageResult = {
    monthlyMortgagePayment: mortgage.monthlyPayment,
    monthlyPaymentDuringGrace: mortgage.monthlyPaymentDuringGrace,
    monthlyPaymentAfterGrace: mortgage.monthlyPaymentAfterGrace,
    totalMortgagePayment: mortgage.totalPayment,
    totalMortgageInterest: mortgage.totalInterest,
    firstMonthPrincipal: mortgage.firstMonthPrincipal,
    firstMonthInterest: mortgage.firstMonthInterest,
    afterGraceFirstMonthPrincipal: mortgage.afterGraceFirstMonthPrincipal,
    afterGraceFirstMonthInterest: mortgage.afterGraceFirstMonthInterest,
    loanPayments: mortgage.payments,
    annualInterestRate: input.annualInterestRate,
    loanTermYears: input.loanTermYears,
    gracePeriodYears: mortgage.gracePeriodYears,
  };

  const presaleStages = input.isPresale
    ? buildPresaleStages(input, houseCashRequired)
    : null;

  const emptyTimelinePoint = (
    extra: Partial<YearTimelinePoint>
  ): YearTimelinePoint => ({
    year: input.startYear,
    cumulative: currentDownPayment,
    isTargetYear: false,
    coveragePercent,
    ...extra,
  });

  if (alreadyReached) {
    return {
      houseCashRequired,
      extraFeesTotal,
      extraFeeItems,
      requiredDownPayment,
      currentDownPayment,
      gap: 0,
      monthsNeeded: 0,
      targetYear: input.startYear,
      targetMonth: input.startMonth,
      coveragePercent: Math.min(coveragePercent, 999),
      alreadyReached: true,
      unreachable: false,
      timeline: [
        emptyTimelinePoint({
          cumulative: Math.min(
            currentDownPayment,
            requiredDownPayment || currentDownPayment
          ),
          isTargetYear: true,
          targetMonth: input.startMonth,
          coveragePercent: Math.min(coveragePercent, 999),
        }),
      ],
      effectiveSelfFundRatio,
      estimatedLoan,
      ...mortgageResult,
      presaleStages,
    };
  }

  if (input.monthlySave <= 0) {
    return {
      houseCashRequired,
      extraFeesTotal,
      extraFeeItems,
      requiredDownPayment,
      currentDownPayment,
      gap,
      monthsNeeded: null,
      targetYear: null,
      targetMonth: null,
      coveragePercent,
      alreadyReached: false,
      unreachable: true,
      timeline: [emptyTimelinePoint({})],
      effectiveSelfFundRatio,
      estimatedLoan,
      ...mortgageResult,
      presaleStages,
    };
  }

  const monthsNeeded = Math.ceil(gap / input.monthlySave);
  const target = addMonths(input.startYear, input.startMonth, monthsNeeded);
  const timeline = buildTimeline(
    input.startYear,
    input.startMonth,
    currentDownPayment,
    input.monthlySave,
    requiredDownPayment,
    monthsNeeded
  );

  return {
    houseCashRequired,
    extraFeesTotal,
    extraFeeItems,
    requiredDownPayment,
    currentDownPayment,
    gap,
    monthsNeeded,
    targetYear: target.year,
    targetMonth: target.month,
    coveragePercent,
    alreadyReached: false,
    unreachable: false,
    timeline,
    effectiveSelfFundRatio,
    estimatedLoan,
    ...mortgageResult,
    presaleStages,
  };
}

export function buildSummaryText(
  input: PlannerInputWan,
  result: PlannerResult
): string {
  const loanPct = Math.round(input.loanRatio * 100);
  const selfPct = Math.round(result.effectiveSelfFundRatio * 100);
  const fees = resolveFeesWan(input);
  const autoTag = (isAuto: boolean) => (isAuto ? "（自動試算）" : "");
  const lines = [
    `【${SITE_NAME}・資產規劃摘要】`,
    `房屋總價：${formatWan(input.housePriceWan)} 萬`,
    input.isPresale
      ? `類型：預售屋（初期自備比例 ${selfPct}%）`
      : `貸款成數：${loanPct}%（自備約 ${selfPct}%）`,
    `房屋自備：${formatWan(yuanToWan(result.houseCashRequired))} 萬`,
    `代書費：${formatWan(fees.notaryFeeWan)} 萬${autoTag(input.notaryFeeWan === null)}`,
    `仲介費：${formatWan(fees.agencyFeeWan)} 萬${autoTag(input.agencyFeeWan === null)}`,
    `裝潢費：${formatWan(fees.decorationFeeWan)} 萬`,
    `其他雜費：${formatWan(fees.otherFeeWan)} 萬`,
    `需準備現金合計：${formatWan(yuanToWan(result.requiredDownPayment))} 萬`,
    `目前自備款：${formatWan(input.currentDownPaymentWan)} 萬`,
    `資金缺口：${formatWan(yuanToWan(result.gap))} 萬`,
    `預估貸款：${formatWan(yuanToWan(result.estimatedLoan))} 萬`,
    `房貸條件：年利率 ${formatWan(input.annualInterestRate, 3)}%、${input.loanTermYears} 年${
      result.gracePeriodYears > 0
        ? `、寬限期 ${result.gracePeriodYears} 年（只繳息）`
        : "、無寬限期"
    }`,
    result.gracePeriodYears > 0
      ? `每月房貸：寬限期約 ${Math.round(result.monthlyPaymentDuringGrace).toLocaleString("zh-TW")} 元，之後約 ${Math.round(result.monthlyPaymentAfterGrace).toLocaleString("zh-TW")} 元（剩餘 ${input.loanTermYears - result.gracePeriodYears} 年本息平均攤還）`
      : `每月房貸：約 ${Math.round(result.monthlyMortgagePayment).toLocaleString("zh-TW")} 元（本息平均攤還）`,
    `總利息：約 ${formatWan(yuanToWan(result.totalMortgageInterest))} 萬`,
    `每月新增：${formatWan(input.monthlySaveWan)} 萬`,
    `開始存錢：${formatYearMonth(input.startYear, input.startMonth)}`,
  ];

  if (result.alreadyReached) {
    lines.push("狀態：目前資金已達標");
  } else if (result.unreachable) {
    lines.push("狀態：在目前每月新增金額下無法估計達標時間");
  } else {
    lines.push(
      `預估需 ${result.monthsNeeded} 個月，約於 ${formatYearMonth(
        result.targetYear!,
        result.targetMonth!
      )} 達標`
    );
  }

  if (result.presaleStages?.length) {
    lines.push("【預售分期現金】");
    for (const stage of result.presaleStages) {
      lines.push(
        `${stage.title}（${formatYearMonth(stage.dueYear, stage.dueMonth)}${
          stage.isCustomDate ? "，自訂" : ""
        }）：需 ${formatWan(yuanToWan(stage.totalCash))} 萬，目前已備 ${formatWan(
          yuanToWan(stage.fundedNow)
        )} 萬${
          stage.reachedNow
            ? "（已達標）"
            : `（尚缺 ${formatWan(yuanToWan(stage.remainingNow))} 萬）`
        }`
      );
    }
  }

  return lines.join("\n");
}
