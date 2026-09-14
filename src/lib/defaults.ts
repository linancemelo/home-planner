import type { PlannerInputWan } from "./types";

export const DEFAULT_PLANNER_INPUT: PlannerInputWan = {
  housePriceWan: 1500,
  loanRatio: 0.8,
  annualInterestRate: 2.2,
  loanTermYears: 40,
  gracePeriodYears: 0,
  currentDownPaymentWan: 150,
  monthlySaveWan: 4,
  startYear: 2027,
  startMonth: 1,
  isPresale: false,
  initialSelfFundRatio: 0.15,
  notaryFeeWan: null,
  agencyFeeWan: null,
  decorationFeeWan: 0,
  otherFeeWan: 0,
};

export const WAN_TO_YUAN = 10_000;

/** 貸款年限上限（年） */
export const MAX_LOAN_TERM_YEARS = 40;

/** 寬限期上限（年） */
export const MAX_GRACE_PERIOD_YEARS = 5;

/** 仲介費行情：買方常見 1%（預售屋建商直售通常沒有） */
export const AGENCY_FEE_RATE = 0.01;

/** 代書費行情：約總價 0.1%，並限制在 1.2–3 萬之間 */
export const NOTARY_FEE_RATE = 0.001;
export const NOTARY_FEE_MIN_WAN = 1.2;
export const NOTARY_FEE_MAX_WAN = 3;

/** 預售屋自備款分期權重（會依初期自備比例縮放） */
export const PRESALE_STAGE_DEFS = [
  {
    id: "contract",
    title: "簽約金",
    hint: "簽約當下繳交",
    weight: 33,
    offsetMonths: 0,
  },
  {
    id: "start",
    title: "開工款",
    hint: "動土／開工通知",
    weight: 20,
    offsetMonths: 6,
  },
  {
    id: "structure",
    title: "結構體完成",
    hint: "工程期款",
    weight: 20,
    offsetMonths: 18,
  },
  {
    id: "exterior",
    title: "外牆／裝修期",
    hint: "工程期款",
    weight: 14,
    offsetMonths: 30,
  },
  {
    id: "handover",
    title: "交屋自備尾款",
    hint: "交屋前繳清自備",
    weight: 13,
    offsetMonths: 36,
  },
] as const;
