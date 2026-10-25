import React, { useState, useMemo, useEffect } from 'react';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  ArcElement,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartData,
  type ChartOptions,
} from 'chart.js';
import { Line, Doughnut } from 'react-chartjs-2';
import {
  AnalyticsSummary,
  BankAccount,
  DateRangePreset,
  SupportedCurrency,
  TransactionCategory,
} from '../lib/types';
import { computeMovingAverage } from '../lib/analytics';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  LineController,
  ArcElement,
  DoughnutController,
  Title,
  Tooltip,
  Legend,
  Filler
);

type ChartDimensionMode =
  | 'cashflow'
  | 'category'
  | 'costStructure'
  | 'necessity'
  | 'cadence';

type CurveStyleMode = 'smooth' | 'linear' | 'stepped';
type AggregationMode = 'periodic' | 'cumulative';

const CATEGORY_PALETTE: Record<
  TransactionCategory,
  { border: string; fill: string }
> = {
  'Housing & Utilities': { border: '#0f172a', fill: 'rgba(15, 23, 42, 0.08)' },
  Groceries: { border: '#0284c7', fill: 'rgba(2, 132, 199, 0.08)' },
  'Shopping & Retail': { border: '#e11d48', fill: 'rgba(225, 29, 72, 0.08)' },
  'Transport & Mobility': { border: '#d97706', fill: 'rgba(217, 119, 6, 0.08)' },
  'Dining & Cafes': { border: '#7c3aed', fill: 'rgba(124, 58, 237, 0.08)' },
  'Health & Pharmacy': { border: '#0d9488', fill: 'rgba(13, 148, 136, 0.08)' },
  'Subscriptions & Media': { border: '#2563eb', fill: 'rgba(37, 99, 235, 0.08)' },
  'Insurance & Finance': { border: '#475569', fill: 'rgba(71, 85, 105, 0.08)' },
  'Travel & Leisure': { border: '#ea580c', fill: 'rgba(234, 88, 12, 0.08)' },
  'Salary & Income': { border: '#16a34a', fill: 'rgba(22, 163, 74, 0.08)' },
  'Internal Transfer': { border: '#94a3b8', fill: 'rgba(148, 163, 184, 0.08)' },
  Other: { border: '#64748b', fill: 'rgba(100, 116, 139, 0.08)' },
};

function toCumulative(series: number[]): number[] {
  let running = 0;
  return series.map((val) => {
    running = Math.round((running + val) * 100) / 100;
    return running;
  });
}

interface TrendAnalyticsViewProps {
  analytics: AnalyticsSummary;
  accounts: BankAccount[];
  selectedAccountId: string;
  onSelectAccount: (id: string) => void;
  datePreset: DateRangePreset;
  onSelectDatePreset: (preset: DateRangePreset) => void;
  movingAverageWindow: number;
  onChangeMovingAverageWindow: (w: number) => void;
  baseCurrency: SupportedCurrency;
  unknownMerchantCount: number;
  totalTransactionCount: number;
  onNavigateToRules: () => void;
  onOpenCsvImport: () => void;
  onClearTransactions: () => Promise<void>;
  onReseedDemoData: () => Promise<void>;
}

export const TrendAnalyticsView: React.FC<TrendAnalyticsViewProps> = ({
  analytics,
  accounts,
  selectedAccountId,
  onSelectAccount,
  datePreset,
  onSelectDatePreset,
  movingAverageWindow,
  onChangeMovingAverageWindow,
  baseCurrency,
  unknownMerchantCount,
  totalTransactionCount,
  onNavigateToRules,
  onOpenCsvImport,
  onClearTransactions,
  onReseedDemoData,
}) => {
  const [confirmClear, setConfirmClear] = useState(false);
  // Customizable Chart Controls
  const [chartDimension, setChartDimension] = useState<ChartDimensionMode>('cashflow');
  const [selectedCategories, setSelectedCategories] = useState<TransactionCategory[]>([]);
  const [showMovingAverage, setShowMovingAverage] = useState<boolean>(true);
  const [showIncomeLine, setShowIncomeLine] = useState<boolean>(true);
  const [showNetCashflowLine, setShowNetCashflowLine] = useState<boolean>(false);
  const [curveStyle, setCurveStyle] = useState<CurveStyleMode>('smooth');
  const [areaFill, setAreaFill] = useState<boolean>(true);
  const [aggregationMode, setAggregationMode] = useState<AggregationMode>('periodic');

  const activeExpenseCategories = useMemo(
    () => analytics.categoryBreakdown.map((c) => c.category),
    [analytics.categoryBreakdown]
  );

  // Initialize selectedCategories with top 4 active expense categories when switching or loading
  useEffect(() => {
    if (activeExpenseCategories.length > 0 && selectedCategories.length === 0) {
      setSelectedCategories(activeExpenseCategories.slice(0, 4));
    }
  }, [activeExpenseCategories, selectedCategories.length]);

  const toggleCategorySelection = (cat: TransactionCategory) => {
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handleFocusSingleCategory = (cat: TransactionCategory) => {
    setChartDimension('category');
    setSelectedCategories([cat]);
  };

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: baseCurrency,
      minimumFractionDigits: 2,
    }).format(val);

  const labels = analytics.timeSeries.map((pt) => pt.label);
  const effectiveWindow =
    analytics.periodGranularity === 'day'
      ? Math.max(7, movingAverageWindow)
      : Math.max(2, movingAverageWindow);

  const tensionValue = curveStyle === 'smooth' ? 0.35 : 0;
  const steppedValue = curveStyle === 'stepped';

  const transformSeries = (raw: number[]): number[] =>
    aggregationMode === 'cumulative' ? toCumulative(raw) : raw;

  // Build Customizable Line Chart Datasets
  const lineChartData: ChartData<'line', number[], string> = useMemo(() => {
    const datasets: ChartData<'line', number[], string>['datasets'] = [];

    if (chartDimension === 'cashflow') {
      const expSeries = transformSeries(analytics.timeSeries.map((pt) => pt.expense));
      datasets.push({
        label:
          aggregationMode === 'cumulative'
            ? 'Cumulative Net Expenses'
            : 'Net Expenses (Actual)',
        data: expSeries,
        borderColor: '#e11d48',
        backgroundColor: areaFill ? 'rgba(225, 29, 72, 0.08)' : 'transparent',
        borderWidth: 2.5,
        pointRadius: 3.5,
        pointHoverRadius: 5,
        pointBackgroundColor: '#e11d48',
        fill: areaFill,
        tension: tensionValue,
        stepped: steppedValue,
      });

      if (showMovingAverage && aggregationMode === 'periodic') {
        datasets.push({
          label: `Expense Trend (${effectiveWindow}${analytics.periodGranularity === 'day' ? 'd' : 'm'} SMA)`,
          data: analytics.timeSeries.map((pt) => pt.expenseMovingAverage),
          borderColor: '#0f172a',
          backgroundColor: 'transparent',
          borderDash: [6, 4],
          borderWidth: 2,
          pointRadius: 2,
          pointBackgroundColor: '#0f172a',
          fill: false,
          tension: tensionValue,
          stepped: steppedValue,
        });
      }

      if (showIncomeLine) {
        const incSeries = transformSeries(analytics.timeSeries.map((pt) => pt.income));
        datasets.push({
          label:
            aggregationMode === 'cumulative' ? 'Cumulative Income' : 'Income (Actual)',
          data: incSeries,
          borderColor: '#16a34a',
          backgroundColor: areaFill ? 'rgba(22, 163, 74, 0.07)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointHoverRadius: 5,
          pointBackgroundColor: '#16a34a',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        });

        if (showMovingAverage && aggregationMode === 'periodic') {
          datasets.push({
            label: `Income Trend (${effectiveWindow}${analytics.periodGranularity === 'day' ? 'd' : 'm'} SMA)`,
            data: analytics.timeSeries.map((pt) => pt.incomeMovingAverage),
            borderColor: '#15803d',
            backgroundColor: 'transparent',
            borderDash: [4, 4],
            borderWidth: 1.75,
            pointRadius: 2,
            pointBackgroundColor: '#15803d',
            fill: false,
            tension: tensionValue,
            stepped: steppedValue,
          });
        }
      }

      if (showNetCashflowLine) {
        const netSeries = transformSeries(analytics.timeSeries.map((pt) => pt.netCashflow));
        datasets.push({
          label:
            aggregationMode === 'cumulative' ? 'Cumulative Net Cashflow' : 'Net Cashflow',
          data: netSeries,
          borderColor: '#0284c7',
          backgroundColor: 'transparent',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#0284c7',
          fill: false,
          tension: tensionValue,
          stepped: steppedValue,
        });
      }
    } else if (chartDimension === 'category') {
      const catsToPlot =
        selectedCategories.length > 0
          ? selectedCategories
          : activeExpenseCategories.slice(0, 3);

      catsToPlot.forEach((cat) => {
        const palette = CATEGORY_PALETTE[cat] || CATEGORY_PALETTE.Other;
        const rawCatSeries = analytics.timeSeries.map(
          (pt) => pt.categoryExpenses[cat] || 0
        );
        const plottedSeries = transformSeries(rawCatSeries);

        datasets.push({
          label: cat,
          data: plottedSeries,
          borderColor: palette.border,
          backgroundColor: areaFill ? palette.fill : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointHoverRadius: 5,
          pointBackgroundColor: palette.border,
          fill: areaFill && catsToPlot.length <= 2,
          tension: tensionValue,
          stepped: steppedValue,
        });

        if (showMovingAverage && aggregationMode === 'periodic' && catsToPlot.length <= 3) {
          const catMa = computeMovingAverage(rawCatSeries, effectiveWindow);
          datasets.push({
            label: `${cat} (${effectiveWindow}${analytics.periodGranularity === 'day' ? 'd' : 'm'} SMA)`,
            data: catMa,
            borderColor: palette.border,
            backgroundColor: 'transparent',
            borderDash: [5, 4],
            borderWidth: 1.75,
            pointRadius: 1.5,
            pointBackgroundColor: palette.border,
            fill: false,
            tension: tensionValue,
            stepped: steppedValue,
          });
        }
      });
    } else if (chartDimension === 'costStructure') {
      const fixedRaw = analytics.timeSeries.map((pt) => pt.fixedExpense);
      const varRaw = analytics.timeSeries.map((pt) => pt.variableExpense);

      datasets.push(
        {
          label: 'Fixed Expenses',
          data: transformSeries(fixedRaw),
          borderColor: '#0f172a',
          backgroundColor: areaFill ? 'rgba(15, 23, 42, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#0f172a',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        },
        {
          label: 'Variable Expenses',
          data: transformSeries(varRaw),
          borderColor: '#0284c7',
          backgroundColor: areaFill ? 'rgba(2, 132, 199, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#0284c7',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        }
      );

      if (showMovingAverage && aggregationMode === 'periodic') {
        datasets.push({
          label: `Variable Expenses (${effectiveWindow}p SMA)`,
          data: computeMovingAverage(varRaw, effectiveWindow),
          borderColor: '#0369a1',
          borderDash: [5, 4],
          borderWidth: 1.75,
          pointRadius: 2,
          fill: false,
          tension: tensionValue,
        });
      }
    } else if (chartDimension === 'necessity') {
      const essRaw = analytics.timeSeries.map((pt) => pt.essentialExpense);
      const discRaw = analytics.timeSeries.map((pt) => pt.discretionaryExpense);

      datasets.push(
        {
          label: 'Essential Needs',
          data: transformSeries(essRaw),
          borderColor: '#0d9488',
          backgroundColor: areaFill ? 'rgba(13, 148, 136, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#0d9488',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        },
        {
          label: 'Discretionary Spending',
          data: transformSeries(discRaw),
          borderColor: '#e11d48',
          backgroundColor: areaFill ? 'rgba(225, 29, 72, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#e11d48',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        }
      );

      if (showMovingAverage && aggregationMode === 'periodic') {
        datasets.push({
          label: `Discretionary (${effectiveWindow}p SMA)`,
          data: computeMovingAverage(discRaw, effectiveWindow),
          borderColor: '#be123c',
          borderDash: [5, 4],
          borderWidth: 1.75,
          pointRadius: 2,
          fill: false,
          tension: tensionValue,
        });
      }
    } else {
      // cadence: Recurring vs. One-Off
      const recRaw = analytics.timeSeries.map((pt) => pt.recurringExpense);
      const oneOffRaw = analytics.timeSeries.map((pt) => pt.oneOffExpense);

      datasets.push(
        {
          label: 'Recurring Commitments',
          data: transformSeries(recRaw),
          borderColor: '#2563eb',
          backgroundColor: areaFill ? 'rgba(37, 99, 235, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#2563eb',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        },
        {
          label: 'One-Off Purchases',
          data: transformSeries(oneOffRaw),
          borderColor: '#d97706',
          backgroundColor: areaFill ? 'rgba(217, 119, 6, 0.08)' : 'transparent',
          borderWidth: 2.5,
          pointRadius: 3.5,
          pointBackgroundColor: '#d97706',
          fill: areaFill,
          tension: tensionValue,
          stepped: steppedValue,
        }
      );

      if (showMovingAverage && aggregationMode === 'periodic') {
        datasets.push({
          label: `One-Off (${effectiveWindow}p SMA)`,
          data: computeMovingAverage(oneOffRaw, effectiveWindow),
          borderColor: '#b45309',
          borderDash: [5, 4],
          borderWidth: 1.75,
          pointRadius: 2,
          fill: false,
          tension: tensionValue,
        });
      }
    }

    return { labels, datasets };
  }, [
    analytics.timeSeries,
    analytics.periodGranularity,
    chartDimension,
    selectedCategories,
    activeExpenseCategories,
    showMovingAverage,
    showIncomeLine,
    showNetCashflowLine,
    curveStyle,
    areaFill,
    aggregationMode,
    effectiveWindow,
    labels,
    tensionValue,
    steppedValue,
  ]);

  const lineChartOptions: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        position: 'top',
        align: 'end',
        labels: {
          boxWidth: 12,
          usePointStyle: true,
          font: {
            family: "'DM Sans', sans-serif",
            size: 12,
          },
          color: '#334155',
        },
      },
      tooltip: {
        backgroundColor: '#0f172a',
        titleFont: { family: "'Plus Jakarta Sans', sans-serif", size: 13 },
        bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
        padding: 12,
        callbacks: {
          label: (ctx) => {
            const val = typeof ctx.parsed.y === 'number' ? ctx.parsed.y : 0;
            return `${ctx.dataset.label}: ${formatCurrency(val)}`;
          },
        },
      },
    },
    scales: {
      x: {
        grid: { display: false },
        ticks: {
          font: { family: "'JetBrains Mono', monospace", size: 11 },
          color: '#64748b',
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 12,
        },
      },
      y: {
        beginAtZero: !showNetCashflowLine,
        grid: { color: 'rgba(15, 23, 42, 0.06)' },
        ticks: {
          font: { family: "'JetBrains Mono', monospace", size: 11 },
          color: '#64748b',
          callback: (value) => `${value} €`,
        },
      },
    },
  };

  // Secondary Category Share Doughnut Chart Data
  const doughnutData: ChartData<'doughnut', number[], string> = useMemo(() => {
    const cats = analytics.categoryBreakdown.filter((c) => c.netExpense > 0);
    return {
      labels: cats.map((c) => c.category),
      datasets: [
        {
          data: cats.map((c) => c.netExpense),
          backgroundColor: cats.map(
            (c) => (CATEGORY_PALETTE[c.category] || CATEGORY_PALETTE.Other).border
          ),
          borderWidth: 2,
          borderColor: '#ffffff',
          hoverOffset: 6,
        },
      ],
    };
  }, [analytics.categoryBreakdown]);

  const doughnutOptions: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '66%',
    plugins: {
      legend: {
        position: 'right',
        labels: {
          boxWidth: 10,
          usePointStyle: true,
          font: { family: "'DM Sans', sans-serif", size: 11 },
          color: '#334155',
        },
      },
      tooltip: {
        backgroundColor: '#0f172a',
        bodyFont: { family: "'JetBrains Mono', monospace", size: 12 },
        callbacks: {
          label: (ctx) => {
            const val = typeof ctx.parsed === 'number' ? ctx.parsed : 0;
            return ` ${ctx.label}: ${formatCurrency(val)}`;
          },
        },
      },
    },
  };

  const totalDimExpense = Math.max(1, analytics.fixedExpenses + analytics.variableExpenses);
  const fixedPct = Math.round((analytics.fixedExpenses / totalDimExpense) * 100);
  const essentialPct = Math.round((analytics.essentialExpenses / totalDimExpense) * 100);
  const recurringPct = Math.round((analytics.recurringExpenses / totalDimExpense) * 100);

  return (
    <div className="space-y-8">
      {/* Workspace Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Customizable Line Chart Studio & Moving-Average Telemetry
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Period <span className="font-mono">{analytics.dateRangeStart}</span> to{' '}
            <span className="font-mono">{analytics.dateRangeEnd}</span> · Granularity:{' '}
            <span className="font-mono">{analytics.periodGranularity}</span> · Zero-filled missing periods active
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Interactive Account Filter */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
            <button
              type="button"
              onClick={() => onSelectAccount('ALL')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                selectedAccountId === 'ALL'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              All Accounts ({accounts.length})
            </button>
            {accounts.map((acc) => (
              <button
                key={acc.id}
                type="button"
                onClick={() => onSelectAccount(acc.id)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  selectedAccountId === acc.id
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {acc.name}
              </button>
            ))}
          </div>

          {/* Interactive Date Range Presets */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg" role="group" aria-label="Date range">
            {(['1M', '3M', '6M', '1Y', 'ALL'] as DateRangePreset[]).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onSelectDatePreset(preset)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  datePreset === preset
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>

          {/* Quick Clear Sample / Ledger Data Control */}
          {totalTransactionCount > 0 ? (
            !confirmClear ? (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors whitespace-nowrap shrink-0"
              >
                Clear Sample / Ledger Data ({totalTransactionCount})
              </button>
            ) : (
              <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-200 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={async () => {
                    await onClearTransactions();
                    setConfirmClear(false);
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-white bg-rose-700 hover:bg-rose-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Confirm Clear All Transactions
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="px-2 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  Cancel
                </button>
              </div>
            )
          ) : (
            <button
              type="button"
              onClick={onReseedDemoData}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded-lg transition-colors whitespace-nowrap shrink-0"
            >
              Load Sample Dataset
            </button>
          )}
        </div>
      </div>

      {/* Primary KPI Grid (Single-Elevation, Tabular Numerals) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Total Income</div>
          <div className="text-2xl font-semibold text-emerald-700 font-mono tabular-nums mt-2">
            {formatCurrency(analytics.totalIncome)}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Excludes internal transfers · Verified inflows
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Net Expenses (After Refunds)</div>
          <div className="text-2xl font-semibold text-rose-700 font-mono tabular-nums mt-2">
            {formatCurrency(analytics.netExpenses)}
          </div>
          <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Gross: {formatCurrency(analytics.grossExpenses)} · Refunds: -{formatCurrency(analytics.totalRefunds)}
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Net Cashflow & Savings Rate</div>
          <div
            className={`text-2xl font-semibold font-mono tabular-nums mt-2 ${
              analytics.netCashflow >= 0 ? 'text-slate-900' : 'text-rose-700'
            }`}
          >
            {analytics.netCashflow >= 0 ? '+' : ''}
            {formatCurrency(analytics.netCashflow)}
          </div>
          <div className="text-xs text-slate-500 mt-2 font-mono tabular-nums">
            Savings rate: {analytics.savingsRate.toFixed(1)}% of income
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="text-xs font-medium text-slate-500">Internal Transfers (Neutral)</div>
          <div className="text-2xl font-semibold text-slate-700 font-mono tabular-nums mt-2">
            {formatCurrency(analytics.totalTransfers)}
          </div>
          <div className="text-xs text-slate-500 mt-2">
            Excluded from spending to prevent double counting
          </div>
        </div>
      </div>

      {/* Prompt for Unclassified Unique Merchants if any */}
      {unknownMerchantCount > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900 font-mono tabular-nums">
              {unknownMerchantCount}
            </span>{' '}
            unique sanitized merchant patterns are currently categorized as{' '}
            <span className="font-mono">Other</span>. You can batch-classify them via the local rules engine or consented LLM pipeline.
          </div>
          <button
            type="button"
            onClick={onNavigateToRules}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            Review Sanitized Merchants ({unknownMerchantCount})
          </button>
        </div>
      )}

      {/* Main Customizable Line Chart Studio */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        {/* Row 1: Chart Dimension Mode Selector + Curve/Aggregation Controls */}
        <div className="flex flex-wrap items-center justify-between gap-4 pb-4 border-b border-slate-100">
          <div className="space-y-1">
            <div className="text-xs font-medium text-slate-500">Line Chart Breakdown Mode</div>
            <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(
                [
                  { id: 'cashflow', label: 'Cashflow (Income vs Expense)' },
                  { id: 'category', label: 'By Category' },
                  { id: 'costStructure', label: 'Fixed vs Variable' },
                  { id: 'necessity', label: 'Essential vs Discretionary' },
                  { id: 'cadence', label: 'Recurring vs One-Off' },
                ] as { id: ChartDimensionMode; label: string }[]
              ).map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  onClick={() => setChartDimension(mode.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    chartDimension === mode.id
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            {/* Aggregation Mode: Periodic vs Cumulative */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-slate-500">Series Type</div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setAggregationMode('periodic')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    aggregationMode === 'periodic'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Periodic
                </button>
                <button
                  type="button"
                  onClick={() => setAggregationMode('cumulative')}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    aggregationMode === 'cumulative'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Cumulative
                </button>
              </div>
            </div>

            {/* Curve Interpolation Style */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-slate-500">Line Geometry</div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                {(['smooth', 'linear', 'stepped'] as CurveStyleMode[]).map((style) => (
                  <button
                    key={style}
                    type="button"
                    onClick={() => setCurveStyle(style)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize whitespace-nowrap shrink-0 ${
                      curveStyle === style
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {style}
                  </button>
                ))}
              </div>
            </div>

            {/* Moving Average Window & Toggles */}
            <div className="space-y-1">
              <div className="text-[11px] font-medium text-slate-500">Trend & Fill</div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
                <button
                  type="button"
                  onClick={() => setAreaFill(!areaFill)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    areaFill
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Area Fill
                </button>
                <button
                  type="button"
                  onClick={() => setShowMovingAverage(!showMovingAverage)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                    showMovingAverage
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  SMA Trend
                </button>
                {[2, 3, 5].map((w) => (
                  <button
                    key={w}
                    type="button"
                    onClick={() => onChangeMovingAverageWindow(w)}
                    className={`px-2 py-1 text-xs font-mono font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                      movingAverageWindow === w
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {w}p
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Row 2: Contextual Sub-Filters (Category Selector or Cashflow Line Toggles) */}
        {chartDimension === 'category' && (
          <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-medium text-slate-600 mr-1">
                Plotted Categories:
              </span>
              {activeExpenseCategories.map((cat) => {
                const isSelected = selectedCategories.includes(cat);
                const color = (CATEGORY_PALETTE[cat] || CATEGORY_PALETTE.Other).border;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategorySelection(cat)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors whitespace-nowrap shrink-0 ${
                      isSelected
                        ? 'bg-white text-slate-900 border-slate-900 shadow-xs'
                        : 'bg-transparent text-slate-500 border-slate-200 hover:text-slate-900'
                    }`}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-xs mr-1.5 align-middle"
                      style={{ backgroundColor: color }}
                    />
                    {cat}
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setSelectedCategories(activeExpenseCategories.slice(0, 3))}
                className="text-xs text-slate-600 hover:text-slate-900 underline"
              >
                Top 3
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={() => setSelectedCategories(activeExpenseCategories)}
                className="text-xs text-slate-600 hover:text-slate-900 underline"
              >
                Select All
              </button>
            </div>
          </div>
        )}

        {chartDimension === 'cashflow' && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-4">
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showIncomeLine}
                  onChange={(e) => setShowIncomeLine(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Plot Income Trajectory</span>
              </label>
              <label className="inline-flex items-center gap-1.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showNetCashflowLine}
                  onChange={(e) => setShowNetCashflowLine(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>Plot Net Cashflow (Income − Expenses)</span>
              </label>
            </div>
            <div className="font-mono tabular-nums text-slate-500">
              {analytics.timeSeries.length} continuous {analytics.periodGranularity} periods plotted
            </div>
          </div>
        )}

        {/* Line Chart Canvas */}
        {analytics.timeSeries.every((p) => p.income === 0 && p.expense === 0) ? (
          <div className="h-80 flex flex-col items-center justify-center text-center p-6">
            <p className="text-sm font-medium text-slate-800">
              No transactions recorded in this date range
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-md">
              Your ledger is currently empty (or has no transactions in this period). Import your own bank CSV statement or load the sample dataset.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button
                type="button"
                onClick={onOpenCsvImport}
                className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
              >
                Import Bank CSV
              </button>
              <button
                type="button"
                onClick={onReseedDemoData}
                className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
              >
                Restore Sample Dataset
              </button>
            </div>
          </div>
        ) : (
          <div className="h-80 w-full">
            <Line data={lineChartData} options={lineChartOptions} />
          </div>
        )}
      </div>

      {/* Secondary Row: Category Share Distribution + Multi-Dimensional Ratios + Interactive Category Table */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: Category Share Doughnut + Multi-Dimensional Structure */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-6">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Category Share & Multi-Dimensional Structure
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Proportional expenditure distribution and Fixed / Essential / Recurring splits
            </p>
          </div>

          {analytics.categoryBreakdown.length > 0 && (
            <div className="h-48 w-full">
              <Doughnut data={doughnutData} options={doughnutOptions} />
            </div>
          )}

          <div className="space-y-4 pt-2 border-t border-slate-100">
            {/* Dimension 1: Fixed vs Variable */}
            <div>
              <div className="flex justify-between text-xs text-slate-700 mb-1">
                <button
                  type="button"
                  onClick={() => setChartDimension('costStructure')}
                  className="hover:underline text-left"
                >
                  Fixed Costs: <strong className="font-mono tabular-nums">{formatCurrency(analytics.fixedExpenses)}</strong> ({fixedPct}%)
                </button>
                <span>
                  Variable: <strong className="font-mono tabular-nums">{formatCurrency(analytics.variableExpenses)}</strong> ({100 - fixedPct}%)
                </span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden flex">
                <div
                  className="bg-slate-900 h-full transition-opacity"
                  style={{ width: `${fixedPct}%` }}
                />
              </div>
            </div>

            {/* Dimension 2: Essential vs Discretionary */}
            <div>
              <div className="flex justify-between text-xs text-slate-700 mb-1">
                <button
                  type="button"
                  onClick={() => setChartDimension('necessity')}
                  className="hover:underline text-left"
                >
                  Essential Needs: <strong className="font-mono tabular-nums">{formatCurrency(analytics.essentialExpenses)}</strong> ({essentialPct}%)
                </button>
                <span>
                  Discretionary: <strong className="font-mono tabular-nums">{formatCurrency(analytics.discretionaryExpenses)}</strong> ({100 - essentialPct}%)
                </span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden flex">
                <div
                  className="bg-emerald-700 h-full transition-opacity"
                  style={{ width: `${essentialPct}%` }}
                />
              </div>
            </div>

            {/* Dimension 3: Recurring vs One-Off */}
            <div>
              <div className="flex justify-between text-xs text-slate-700 mb-1">
                <button
                  type="button"
                  onClick={() => setChartDimension('cadence')}
                  className="hover:underline text-left"
                >
                  Recurring: <strong className="font-mono tabular-nums">{formatCurrency(analytics.recurringExpenses)}</strong> ({recurringPct}%)
                </button>
                <span>
                  One-Off: <strong className="font-mono tabular-nums">{formatCurrency(analytics.oneOffExpenses)}</strong> ({100 - recurringPct}%)
                </span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden flex">
                <div
                  className="bg-sky-700 h-full transition-opacity"
                  style={{ width: `${recurringPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Interactive Category Breakdown Table */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Category Totals (Click Any Category to Plot Line Trend)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Sorted by net expenditure · Refunds automatically credited back to originating category
              </p>
            </div>
            {chartDimension === 'category' && (
              <button
                type="button"
                onClick={() => setChartDimension('cashflow')}
                className="text-xs font-medium text-slate-600 hover:text-slate-900 underline"
              >
                Reset to Cashflow View
              </button>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 font-medium">Category</th>
                  <th className="py-2.5 font-medium text-right">Transactions</th>
                  <th className="py-2.5 font-medium text-right">Gross Spend</th>
                  <th className="py-2.5 font-medium text-right">Refunds</th>
                  <th className="py-2.5 font-medium text-right">Net Spend</th>
                  <th className="py-2.5 font-medium text-right">Share</th>
                  <th className="py-2.5 font-medium text-right">Line Chart</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {analytics.categoryBreakdown.map((item) => {
                  const isPlotted =
                    chartDimension === 'category' &&
                    selectedCategories.includes(item.category);
                  const swatchColor = (
                    CATEGORY_PALETTE[item.category] || CATEGORY_PALETTE.Other
                  ).border;
                  return (
                    <tr
                      key={item.category}
                      onClick={() => handleFocusSingleCategory(item.category)}
                      className={`cursor-pointer transition-colors ${
                        isPlotted ? 'bg-slate-100/90' : 'hover:bg-slate-50/80'
                      }`}
                    >
                      <td className="py-2.5 font-medium text-slate-900">
                        <span
                          className="inline-block w-2.5 h-2.5 rounded-xs mr-2 align-middle"
                          style={{ backgroundColor: swatchColor }}
                        />
                        {item.category}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-xs text-slate-600">
                        {item.transactionCount}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-xs text-slate-600">
                        {formatCurrency(item.grossExpense)}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-xs text-emerald-700">
                        {item.refunds > 0 ? `-${formatCurrency(item.refunds)}` : '—'}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums font-medium text-slate-900">
                        {formatCurrency(item.netExpense)}
                      </td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-xs text-slate-600">
                        {item.percentageOfTotal.toFixed(1)}%
                      </td>
                      <td
                        className="py-2.5 text-right"
                        onClick={(e) => {
                          e.stopPropagation();
                          setChartDimension('category');
                          toggleCategorySelection(item.category);
                        }}
                      >
                        <button
                          type="button"
                          className={`px-2 py-0.5 text-xs font-medium rounded border transition-colors ${
                            isPlotted
                              ? 'bg-slate-900 text-white border-slate-900'
                              : 'bg-white text-slate-600 border-slate-200 hover:border-slate-400'
                          }`}
                        >
                          {isPlotted ? 'Plotted' : 'Plot'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {analytics.categoryBreakdown.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-8 text-center text-xs text-slate-500">
                      No expense categories in the selected period.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};
