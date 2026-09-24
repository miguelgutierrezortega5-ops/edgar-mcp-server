import { firstAvailable, reportingCurrency, type CompanyFacts, type PeriodKind, type Point } from "./xbrl.js";

export type StatementType = "income" | "balance" | "cashflow";

export interface LineDef {
  key: string;
  label: string;
  candidates: string[];
  unit?: "per_share" | "shares";
}

// Most common us-gaap tags first, then IFRS equivalents for foreign private issuers (20-F/40-F).
export const STATEMENTS: Record<StatementType, LineDef[]> = {
  income: [
    { key: "revenue", label: "Revenue", candidates: ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense", "ifrs-full:Revenue"] },
    { key: "cost_of_revenue", label: "Cost of revenue", candidates: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "ifrs-full:CostOfSales"] },
    { key: "gross_profit", label: "Gross profit", candidates: ["GrossProfit", "ifrs-full:GrossProfit"] },
    { key: "rnd", label: "R&D", candidates: ["ResearchAndDevelopmentExpense", "ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost", "ifrs-full:ResearchAndDevelopmentExpense"] },
    { key: "sga", label: "SG&A", candidates: ["SellingGeneralAndAdministrativeExpense", "ifrs-full:SellingGeneralAndAdministrativeExpense"] },
    { key: "operating_income", label: "Operating income", candidates: ["OperatingIncomeLoss", "ifrs-full:ProfitLossFromOperatingActivities"] },
    { key: "interest_expense", label: "Interest expense", candidates: ["InterestExpense", "InterestExpenseNonoperating", "InterestExpenseDebt", "ifrs-full:FinanceCosts"] },
    { key: "pretax_income", label: "Pre-tax income", candidates: ["IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest", "IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments", "ifrs-full:ProfitLossBeforeTax"] },
    { key: "income_tax", label: "Income tax", candidates: ["IncomeTaxExpenseBenefit", "ifrs-full:IncomeTaxExpenseContinuingOperations"] },
    { key: "net_income", label: "Net income", candidates: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ifrs-full:ProfitLossAttributableToOwnersOfParent", "ifrs-full:ProfitLoss"] },
    { key: "eps_basic", label: "EPS (basic)", candidates: ["EarningsPerShareBasic", "ifrs-full:BasicEarningsLossPerShare"], unit: "per_share" },
    { key: "eps_diluted", label: "EPS (diluted)", candidates: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted", "ifrs-full:DilutedEarningsLossPerShare"], unit: "per_share" },
    { key: "diluted_shares", label: "Diluted shares", candidates: ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfShareOutstandingBasicAndDiluted", "ifrs-full:AdjustedWeightedAverageShares"], unit: "shares" },
  ],
  balance: [
    { key: "cash", label: "Cash & equivalents", candidates: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash", "ifrs-full:CashAndCashEquivalents"] },
    { key: "short_term_investments", label: "Short-term investments", candidates: ["ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "MarketableSecuritiesCurrent", "ifrs-full:CurrentInvestments"] },
    { key: "receivables", label: "Receivables", candidates: ["AccountsReceivableNetCurrent", "ReceivablesNetCurrent", "ifrs-full:TradeAndOtherCurrentReceivables"] },
    { key: "inventory", label: "Inventory", candidates: ["InventoryNet", "ifrs-full:Inventories"] },
    { key: "current_assets", label: "Total current assets", candidates: ["AssetsCurrent", "ifrs-full:CurrentAssets"] },
    { key: "ppe", label: "PP&E (net)", candidates: ["PropertyPlantAndEquipmentNet", "PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization", "ifrs-full:PropertyPlantAndEquipment"] },
    { key: "goodwill", label: "Goodwill", candidates: ["Goodwill", "ifrs-full:Goodwill"] },
    { key: "total_assets", label: "Total assets", candidates: ["Assets", "ifrs-full:Assets"] },
    { key: "accounts_payable", label: "Accounts payable", candidates: ["AccountsPayableCurrent", "ifrs-full:TradeAndOtherCurrentPayables"] },
    { key: "current_liabilities", label: "Total current liabilities", candidates: ["LiabilitiesCurrent", "ifrs-full:CurrentLiabilities"] },
    { key: "long_term_debt", label: "Long-term debt", candidates: ["LongTermDebtNoncurrent", "LongTermDebt", "LongTermDebtAndCapitalLeaseObligations", "ifrs-full:NoncurrentPortionOfNoncurrentBorrowings", "ifrs-full:NoncurrentBorrowings"] },
    { key: "total_liabilities", label: "Total liabilities", candidates: ["Liabilities", "ifrs-full:Liabilities"] },
    { key: "equity", label: "Shareholders' equity", candidates: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest", "ifrs-full:EquityAttributableToOwnersOfParent", "ifrs-full:Equity"] },
  ],
  cashflow: [
    { key: "cfo", label: "Operating cash flow", candidates: ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations", "ifrs-full:CashFlowsFromUsedInOperatingActivities"] },
    { key: "capex", label: "Capex", candidates: ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets", "ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities"] },
    { key: "dna", label: "D&A", candidates: ["DepreciationDepletionAndAmortization", "DepreciationAndAmortization", "DepreciationAmortizationAndAccretionNet", "Depreciation", "ifrs-full:DepreciationAndAmortisationExpense"] },
    { key: "sbc", label: "Stock-based comp.", candidates: ["ShareBasedCompensation", "AllocatedShareBasedCompensationExpense", "ifrs-full:AdjustmentsForSharebasedPayments"] },
    { key: "cfi", label: "Investing cash flow", candidates: ["NetCashProvidedByUsedInInvestingActivities", "ifrs-full:CashFlowsFromUsedInInvestingActivities"] },
    { key: "cff", label: "Financing cash flow", candidates: ["NetCashProvidedByUsedInFinancingActivities", "ifrs-full:CashFlowsFromUsedInFinancingActivities"] },
    { key: "buybacks", label: "Share buybacks", candidates: ["PaymentsForRepurchaseOfCommonStock", "ifrs-full:PaymentsToAcquireOrRedeemEntitysShares"] },
    { key: "dividends", label: "Dividends paid", candidates: ["PaymentsOfDividends", "PaymentsOfDividendsCommonStock", "ifrs-full:DividendsPaidClassifiedAsFinancingActivities"] },
  ],
};

export interface Row {
  key: string;
  label: string;
  unit: string;
  concept?: string;
  values: (number | null)[];
}

export interface StatementTable {
  kind: PeriodKind;
  periods: string[]; // period end dates, oldest → newest
  currency?: string;
  rows: Row[];
  derivedQuarters: boolean;
}

/** Load line items; `currency` (default: the company's reporting currency) keeps every row in one currency. */
export function loadLines(
  facts: CompanyFacts,
  defs: LineDef[],
  kind: PeriodKind,
  currency = reportingCurrency(facts),
): Map<string, { def: LineDef; series: Map<string, Point> }> {
  return new Map(defs.map((d) => [d.key, { def: d, series: firstAvailable(facts, d.candidates, kind, d.unit, currency) }]));
}

/** Pick the `max` most recent period ends from the anchor series (first line with data). */
export function selectPeriods(lines: { series: Map<string, Point> }[], max: number): string[] {
  const anchor = lines.find((l) => l.series.size > 0);
  if (!anchor) return [];
  return [...anchor.series.keys()].sort().slice(-max);
}

export function buildStatement(facts: CompanyFacts, type: StatementType, kind: PeriodKind, maxPeriods: number): StatementTable {
  const reporting = reportingCurrency(facts);
  const lines = loadLines(facts, STATEMENTS[type], kind, reporting);
  const periods = selectPeriods([...lines.values()], maxPeriods);
  let derivedQuarters = false;
  let currency: string | undefined = reporting;
  const rows: Row[] = [];
  for (const { def, series } of lines.values()) {
    const values = periods.map((p) => series.get(p)?.val ?? null);
    if (values.every((v) => v === null)) continue;
    const sample = periods.map((p) => series.get(p)).find(Boolean);
    if (periods.some((p) => series.get(p)?.derived)) derivedQuarters = true;
    if (!def.unit && sample) currency ??= sample.unit;
    rows.push({ key: def.key, label: def.label, unit: def.unit ?? sample?.unit ?? "", concept: sample?.concept, values });
  }
  if (type === "cashflow") {
    const cfo = rows.find((r) => r.key === "cfo");
    const capex = rows.find((r) => r.key === "capex");
    if (cfo && capex) {
      rows.push({
        key: "fcf",
        label: "Free cash flow (CFO − capex)",
        unit: cfo.unit,
        values: cfo.values.map((v, i) => (v !== null && capex.values[i] !== null ? v - capex.values[i]! : null)),
      });
    }
  }
  return { kind, periods, currency, rows, derivedQuarters };
}
