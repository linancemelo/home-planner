export type PresaleStageId =
  | "contract"
  | "start"
  | "structure"
  | "exterior"
  | "handover";

export interface YearMonth {
  year: number;
  month: number;
}

export type PresaleDueDates = Partial<Record<PresaleStageId, YearMonth>>;

/** 規劃輸入（UI 以「萬元」為單位，計算內部轉為「元」） */
export interface PlannerInputWan {
  housePriceWan: number;
  loanRatio: number;
  /** 房貸年利率（百分比，例如 2 代表 2%） */
  annualInterestRate: number;
  /** 房貸年限 */
  loanTermYears: number;
  /** 寬限期（年）；期間只繳息不還本，含在貸款年限內 */
  gracePeriodYears: number;
  currentDownPaymentWan: number;
  monthlySaveWan: number;
  startYear: number;
  startMonth: number;
  isPresale: boolean;
  initialSelfFundRatio: number;
  /** 預售各期自訂到期年月；沒填的期別依 2 年工期自動推估 */
  presaleDueDates: PresaleDueDates;
  /** 代書費（萬元）；null 代表依房屋總價自動試算 */
  notaryFeeWan: number | null;
  /** 仲介費（萬元）；null 代表依房屋總價自動試算 */
  agencyFeeWan: number | null;
  /** 裝潢費（萬元） */
  decorationFeeWan: number;
  /** 其他雜費：契稅、印花、火險等（萬元） */
  otherFeeWan: number;
}

export interface PlannerInput {
  housePrice: number;
  loanRatio: number;
  annualInterestRate: number;
  loanTermYears: number;
  gracePeriodYears: number;
  currentDownPayment: number;
  monthlySave: number;
  startYear: number;
  startMonth: number;
  isPresale: boolean;
  initialSelfFundRatio: number;
  presaleDueDates: PresaleDueDates;
  notaryFee: number;
  agencyFee: number;
  decorationFee: number;
  otherFee: number;
}

export interface YearTimelinePoint {
  year: number;
  cumulative: number;
  isTargetYear: boolean;
  targetMonth?: number;
  coveragePercent: number;
}

export interface ExtraFeeItem {
  id: string;
  label: string;
  amount: number;
}

export interface PresaleStage {
  id: PresaleStageId;
  title: string;
  hint: string;
  /** 佔總價比例（僅房屋自備部分） */
  ofHousePriceRatio: number;
  /** 本階段房屋自備金額（元） */
  houseCash: number;
  /** 本階段附加費用（元） */
  extraFees: ExtraFeeItem[];
  /** 本階段需現金合計（元） */
  totalCash: number;
  /** 從開始月起到本期到期的月數；自訂日期早於開始月時為負值 */
  offsetMonths: number;
  /** 到期日是否為使用者自訂 */
  isCustomDate: boolean;
  /** 截至本階段需累積的現金（元） */
  cumulativeRequired: number;
  /** 以目前自備款依序分配到本階段的金額（元） */
  fundedNow: number;
  /** 目前距離本階段還缺的金額（元） */
  remainingNow: number;
  /** 目前資金是否已夠付本階段 */
  reachedNow: boolean;
  /** 目前資金對本階段的覆蓋率 */
  coverageNow: number;
  /** 到期時預估可動用現金（元） */
  projectedCashAtDue: number;
  /** 到期時依序分配到本階段的金額（元） */
  fundedAtDue: number;
  /** 到期時是否預估夠付截至本階段的累積款 */
  reachedAtDue: boolean;
  /** 期款到期年月 */
  dueYear: number;
  dueMonth: number;
  /** 存滿累積款所需月數；0 代表現在就夠、null 代表沒有儲蓄無法估算 */
  readyMonths: number | null;
  /** 預估存滿累積款的年月；null 代表無法估算 */
  readyYear: number | null;
  readyMonth: number | null;
  /** 存滿時間比期款日提前的月數；負值代表落後、null 代表無法估算 */
  monthsAheadOfDue: number | null;
}

export interface PlannerResult {
  houseCashRequired: number;
  extraFeesTotal: number;
  extraFeeItems: ExtraFeeItem[];
  requiredDownPayment: number;
  currentDownPayment: number;
  gap: number;
  monthsNeeded: number | null;
  targetYear: number | null;
  targetMonth: number | null;
  coveragePercent: number;
  alreadyReached: boolean;
  unreachable: boolean;
  timeline: YearTimelinePoint[];
  effectiveSelfFundRatio: number;
  estimatedLoan: number;
  monthlyMortgagePayment: number;
  monthlyPaymentDuringGrace: number;
  monthlyPaymentAfterGrace: number;
  totalMortgagePayment: number;
  totalMortgageInterest: number;
  firstMonthPrincipal: number;
  firstMonthInterest: number;
  afterGraceFirstMonthPrincipal: number;
  afterGraceFirstMonthInterest: number;
  loanPayments: number;
  annualInterestRate: number;
  loanTermYears: number;
  gracePeriodYears: number;
  presaleStages: PresaleStage[] | null;
}

export type DiagnosisSectionType = "advantages" | "risks" | "suggestions";

export interface DiagnosisSection {
  type: DiagnosisSectionType;
  title: string;
  items: string[];
}

export interface DiagnosisResult {
  overview: string;
  sections: DiagnosisSection[];
  disclaimer: string;
}
