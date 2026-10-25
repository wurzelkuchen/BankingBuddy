import {
  AnalyticsSummary,
  CategoryBreakdownItem,
  DateRangePreset,
  TimeSeriesPoint,
  TransactionCategory,
  TransactionRecord,
} from './types';

export const ALL_TRANSACTION_CATEGORIES: TransactionCategory[] = [
  'Groceries',
  'Housing & Utilities',
  'Transport & Mobility',
  'Dining & Cafes',
  'Health & Pharmacy',
  'Shopping & Retail',
  'Subscriptions & Media',
  'Insurance & Finance',
  'Salary & Income',
  'Internal Transfer',
  'Travel & Leisure',
  'Other',
];

function createEmptyCategoryRecord(): Record<TransactionCategory, number> {
  return {
    Groceries: 0,
    'Housing & Utilities': 0,
    'Transport & Mobility': 0,
    'Dining & Cafes': 0,
    'Health & Pharmacy': 0,
    'Shopping & Retail': 0,
    'Subscriptions & Media': 0,
    'Insurance & Finance': 0,
    'Salary & Income': 0,
    'Internal Transfer': 0,
    'Travel & Leisure': 0,
    Other: 0,
  };
}

/**
 * Computes simple moving average (SMA) over a numeric series with configurable window size.
 * Handles leading partial windows smoothly so every point has a valid trend value.
 */
export function computeMovingAverage(values: number[], windowSize: number): number[] {
  const effectiveWindow = Math.max(1, Math.floor(windowSize));
  const result: number[] = [];

  for (let i = 0; i < values.length; i++) {
    const startIdx = Math.max(0, i - effectiveWindow + 1);
    let sum = 0;
    let count = 0;
    for (let j = startIdx; j <= i; j++) {
      sum += values[j];
      count++;
    }
    result.push(Math.round((sum / count) * 100) / 100);
  }

  return result;
}

/**
 * Resolves start and end ISO dates (YYYY-MM-DD) for a given preset relative to a reference anchor date.
 * If anchorDateStr is not provided, defaults to the latest transaction date in the dataset (or today).
 */
export function resolveDateRangeBounds(
  preset: DateRangePreset,
  transactions: TransactionRecord[],
  anchorDateStr?: string
): { startDate: string; endDate: string; granularity: 'day' | 'month' } {
  const sortedDates = transactions
    .map((t) => t.bookingDate)
    .filter(Boolean)
    .sort();

  const endIso =
    anchorDateStr ||
    (sortedDates.length > 0 ? sortedDates[sortedDates.length - 1] : new Date().toISOString().slice(0, 10));

  const endObj = new Date(`${endIso}T00:00:00Z`);

  if (preset === 'ALL') {
    const startIso = sortedDates.length > 0 ? sortedDates[0] : endIso;
    const spanDays = Math.max(
      1,
      Math.round((endObj.getTime() - new Date(`${startIso}T00:00:00Z`).getTime()) / (1000 * 60 * 60 * 24))
    );
    return {
      startDate: startIso,
      endDate: endIso,
      granularity: spanDays <= 62 ? 'day' : 'month',
    };
  }

  const startObj = new Date(endObj);
  if (preset === '1M') {
    startObj.setUTCDate(startObj.getUTCDate() - 29);
    return {
      startDate: startObj.toISOString().slice(0, 10),
      endDate: endIso,
      granularity: 'day',
    };
  }

  if (preset === '3M') {
    startObj.setUTCMonth(startObj.getUTCMonth() - 2);
    startObj.setUTCDate(1);
    return {
      startDate: startObj.toISOString().slice(0, 10),
      endDate: endIso,
      granularity: 'month',
    };
  }

  if (preset === '6M') {
    startObj.setUTCMonth(startObj.getUTCMonth() - 5);
    startObj.setUTCDate(1);
    return {
      startDate: startObj.toISOString().slice(0, 10),
      endDate: endIso,
      granularity: 'month',
    };
  }

  // '1Y'
  startObj.setUTCMonth(startObj.getUTCMonth() - 11);
  startObj.setUTCDate(1);
  return {
    startDate: startObj.toISOString().slice(0, 10),
    endDate: endIso,
    granularity: 'month',
  };
}

/**
 * Generates a continuous list of period keys (every day or every month) between startDate and endDate
 * to guarantee zero-filled missing periods on charts and moving-average calculations.
 */
export function generateContinuousPeriods(
  startDate: string,
  endDate: string,
  granularity: 'day' | 'month'
): { periodKey: string; label: string }[] {
  const periods: { periodKey: string; label: string }[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return [{ periodKey: endDate.slice(0, 7), label: endDate.slice(0, 7) }];
  }

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  if (granularity === 'day') {
    const cursor = new Date(start);
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      const label = `${monthNames[cursor.getUTCMonth()]} ${String(cursor.getUTCDate()).padStart(2, '0')}`;
      periods.push({ periodKey: iso, label });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  } else {
    const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cursor <= endMonth) {
      const yyyy = cursor.getUTCFullYear();
      const mm = String(cursor.getUTCMonth() + 1).padStart(2, '0');
      const periodKey = `${yyyy}-${mm}`;
      const label = `${monthNames[cursor.getUTCMonth()]} ${yyyy}`;
      periods.push({ periodKey, label });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  return periods;
}

/**
 * Computes full financial analytics, category totals, multi-dimensional ratios,
 * missing-period zero-filled series, and moving-average trend lines.
 */
export function calculateFinancialAnalytics(
  allTransactions: TransactionRecord[],
  preset: DateRangePreset = '6M',
  movingAverageWindow = 3,
  accountFilterId = 'ALL',
  anchorDateStr?: string
): AnalyticsSummary {
  const accountFiltered =
    accountFilterId === 'ALL'
      ? allTransactions
      : allTransactions.filter((t) => t.accountId === accountFilterId);

  const { startDate, endDate, granularity } = resolveDateRangeBounds(
    preset,
    accountFiltered,
    anchorDateStr
  );

  const inRange = accountFiltered.filter(
    (t) => t.bookingDate >= startDate && t.bookingDate <= endDate
  );

  let totalIncome = 0;
  let grossExpenses = 0;
  let totalRefunds = 0;
  let totalTransfers = 0;

  let fixedExpenses = 0;
  let variableExpenses = 0;
  let essentialExpenses = 0;
  let discretionaryExpenses = 0;
  let recurringExpenses = 0;
  let oneOffExpenses = 0;

  const categoryMap = new Map<
    TransactionCategory,
    { gross: number; refunds: number; count: number }
  >();

  const continuousPeriods = generateContinuousPeriods(startDate, endDate, granularity);
  const periodBucketMap = new Map<
    string,
    {
      label: string;
      income: number;
      grossExpense: number;
      refunds: number;
      transfers: number;
      count: number;
      categoryExpenses: Record<TransactionCategory, number>;
      fixedExpense: number;
      variableExpense: number;
      essentialExpense: number;
      discretionaryExpense: number;
      recurringExpense: number;
      oneOffExpense: number;
    }
  >();

  for (const p of continuousPeriods) {
    periodBucketMap.set(p.periodKey, {
      label: p.label,
      income: 0,
      grossExpense: 0,
      refunds: 0,
      transfers: 0,
      count: 0,
      categoryExpenses: createEmptyCategoryRecord(),
      fixedExpense: 0,
      variableExpense: 0,
      essentialExpense: 0,
      discretionaryExpense: 0,
      recurringExpense: 0,
      oneOffExpense: 0,
    });
  }

  for (const tx of inRange) {
    const absAmount = Math.abs(tx.amountInBaseCurrency);
    const periodKey = granularity === 'day' ? tx.bookingDate : tx.bookingDate.slice(0, 7);
    const bucket = periodBucketMap.get(periodKey);
    if (bucket) {
      bucket.count++;
    }

    if (tx.direction === 'transfer' || tx.category === 'Internal Transfer') {
      totalTransfers += absAmount;
      if (bucket) bucket.transfers += absAmount;
      continue;
    }

    if (tx.direction === 'income') {
      totalIncome += absAmount;
      if (bucket) bucket.income += absAmount;
      continue;
    }

    if (tx.direction === 'refund') {
      totalRefunds += absAmount;
      if (bucket) {
        bucket.refunds += absAmount;
        bucket.categoryExpenses[tx.category] =
          (bucket.categoryExpenses[tx.category] || 0) - absAmount;
      }
      const catEntry = categoryMap.get(tx.category) || { gross: 0, refunds: 0, count: 0 };
      catEntry.refunds += absAmount;
      catEntry.count += 1;
      categoryMap.set(tx.category, catEntry);
      continue;
    }

    // Expense
    grossExpenses += absAmount;
    if (bucket) {
      bucket.grossExpense += absAmount;
      bucket.categoryExpenses[tx.category] =
        (bucket.categoryExpenses[tx.category] || 0) + absAmount;

      if (tx.costStructure === 'Fixed') bucket.fixedExpense += absAmount;
      else bucket.variableExpense += absAmount;

      if (tx.necessity === 'Essential') bucket.essentialExpense += absAmount;
      else bucket.discretionaryExpense += absAmount;

      if (tx.cadence === 'Recurring') bucket.recurringExpense += absAmount;
      else bucket.oneOffExpense += absAmount;
    }

    const catEntry = categoryMap.get(tx.category) || { gross: 0, refunds: 0, count: 0 };
    catEntry.gross += absAmount;
    catEntry.count += 1;
    categoryMap.set(tx.category, catEntry);

    if (tx.costStructure === 'Fixed') fixedExpenses += absAmount;
    else variableExpenses += absAmount;

    if (tx.necessity === 'Essential') essentialExpenses += absAmount;
    else discretionaryExpenses += absAmount;

    if (tx.cadence === 'Recurring') recurringExpenses += absAmount;
    else oneOffExpenses += absAmount;
  }

  const netExpenses = Math.max(0, Math.round((grossExpenses - totalRefunds) * 100) / 100);
  const netCashflow = Math.round((totalIncome - netExpenses) * 100) / 100;
  const savingsRate =
    totalIncome > 0 ? Math.round(((totalIncome - netExpenses) / totalIncome) * 1000) / 10 : 0;

  // Build Category Breakdown sorted by netExpense descending
  const categoryBreakdown: CategoryBreakdownItem[] = [];
  for (const [category, stats] of categoryMap.entries()) {
    const netCat = Math.max(0, Math.round((stats.gross - stats.refunds) * 100) / 100);
    categoryBreakdown.push({
      category,
      grossExpense: Math.round(stats.gross * 100) / 100,
      refunds: Math.round(stats.refunds * 100) / 100,
      netExpense: netCat,
      percentageOfTotal: netExpenses > 0 ? Math.round((netCat / netExpenses) * 1000) / 10 : 0,
      transactionCount: stats.count,
    });
  }
  categoryBreakdown.sort((a, b) => b.netExpense - a.netExpense);

  // Build TimeSeries with Moving Average
  const rawPeriodPoints = continuousPeriods.map((p) => {
    const b = periodBucketMap.get(p.periodKey)!;
    const netExp = Math.max(0, Math.round((b.grossExpense - b.refunds) * 100) / 100);
    const inc = Math.round(b.income * 100) / 100;

    const normalizedCatExpenses = createEmptyCategoryRecord();
    for (const cat of ALL_TRANSACTION_CATEGORIES) {
      normalizedCatExpenses[cat] = Math.round((b.categoryExpenses[cat] || 0) * 100) / 100;
    }

    return {
      periodKey: p.periodKey,
      label: b.label,
      income: inc,
      expense: netExp,
      grossExpense: Math.round(b.grossExpense * 100) / 100,
      refunds: Math.round(b.refunds * 100) / 100,
      transfers: Math.round(b.transfers * 100) / 100,
      netCashflow: Math.round((inc - netExp) * 100) / 100,
      transactionCount: b.count,
      categoryExpenses: normalizedCatExpenses,
      fixedExpense: Math.round(b.fixedExpense * 100) / 100,
      variableExpense: Math.round(b.variableExpense * 100) / 100,
      essentialExpense: Math.round(b.essentialExpense * 100) / 100,
      discretionaryExpense: Math.round(b.discretionaryExpense * 100) / 100,
      recurringExpense: Math.round(b.recurringExpense * 100) / 100,
      oneOffExpense: Math.round(b.oneOffExpense * 100) / 100,
    };
  });

  const effectiveWindow =
    granularity === 'day' ? Math.max(7, movingAverageWindow) : Math.max(2, movingAverageWindow);

  const expenseMA = computeMovingAverage(
    rawPeriodPoints.map((p) => p.expense),
    effectiveWindow
  );
  const incomeMA = computeMovingAverage(
    rawPeriodPoints.map((p) => p.income),
    effectiveWindow
  );

  const timeSeries: TimeSeriesPoint[] = rawPeriodPoints.map((pt, idx) => ({
    ...pt,
    expenseMovingAverage: expenseMA[idx],
    incomeMovingAverage: incomeMA[idx],
  }));

  return {
    totalIncome: Math.round(totalIncome * 100) / 100,
    grossExpenses: Math.round(grossExpenses * 100) / 100,
    totalRefunds: Math.round(totalRefunds * 100) / 100,
    netExpenses,
    totalTransfers: Math.round(totalTransfers * 100) / 100,
    netCashflow,
    savingsRate,
    fixedExpenses: Math.round(fixedExpenses * 100) / 100,
    variableExpenses: Math.round(variableExpenses * 100) / 100,
    essentialExpenses: Math.round(essentialExpenses * 100) / 100,
    discretionaryExpenses: Math.round(discretionaryExpenses * 100) / 100,
    recurringExpenses: Math.round(recurringExpenses * 100) / 100,
    oneOffExpenses: Math.round(oneOffExpenses * 100) / 100,
    categoryBreakdown,
    timeSeries,
    periodGranularity: granularity,
    dateRangeStart: startDate,
    dateRangeEnd: endDate,
  };
}
