/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AppSettings,
  BankAccount,
  CadenceTag,
  CostStructureTag,
  DateRangePreset,
  MerchantRule,
  NecessityTag,
  TransactionCategory,
  TransactionDirection,
  TransactionRecord,
} from './lib/types';
import {
  clearAllLocalData,
  clearTransactionsOnly,
  db,
  DEFAULT_SETTINGS,
  ensureInitialSeedData,
} from './lib/db';
import { calculateFinancialAnalytics } from './lib/analytics';
import { PlainBackupPayload } from './lib/cryptoBackup';
import { TrendAnalyticsView } from './components/TrendAnalyticsView';
import { LedgerAndImportView } from './components/LedgerAndImportView';
import { LlmDebugAndApprovalView } from './components/LlmDebugAndApprovalView';
import { BackupAndStorageView } from './components/BackupAndStorageView';
import { ArchitectureAndTestsView } from './components/ArchitectureAndTestsView';
import {
  BarChart3,
  Table2,
  Upload,
  ShieldCheck,
  DatabaseBackup,
  Menu,
  X,
} from 'lucide-react';

type ActiveSection = 'overview' | 'table' | 'import' | 'llm_debug' | 'backups';

const NAV_ITEMS: {
  id: ActiveSection;
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  {
    id: 'overview',
    label: 'Overview',
    shortLabel: 'Overview',
    description: 'Interactive line charts, moving averages & KPIs',
    icon: BarChart3,
  },
  {
    id: 'table',
    label: 'Transactions Table',
    shortLabel: 'Table',
    description: 'Individual lines & inline AI category editor',
    icon: Table2,
  },
  {
    id: 'import',
    label: 'CSV Import',
    shortLabel: 'Import',
    description: 'Upload bank CSVs & manual column matching',
    icon: Upload,
  },
  {
    id: 'llm_debug',
    label: 'LLM Debug & Approval',
    shortLabel: 'LLM Debug',
    description: 'Approve outbound sanitized strings & rules',
    icon: ShieldCheck,
  },
  {
    id: 'backups',
    label: 'Backups & CI/CD',
    shortLabel: 'Backups',
    description: 'Encrypted export, clear data & Android CI/CD',
    icon: DatabaseBackup,
  },
];

export default function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const [accounts, setAccounts] = useState<BankAccount[]>([]);
  const [transactions, setTransactions] = useState<TransactionRecord[]>([]);
  const [rules, setRules] = useState<MerchantRule[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // Analytics Filter Controls
  const [selectedAccountId, setSelectedAccountId] = useState<string>('ALL');
  const [datePreset, setDatePreset] = useState<DateRangePreset>('6M');
  const [movingAverageWindow, setMovingAverageWindow] = useState<number>(3);

  const reloadFromIndexedDB = useCallback(async () => {
    const [accList, txList, ruleList, savedSettings] = await Promise.all([
      db.accounts.toArray(),
      db.transactions.toArray(),
      db.rules.toArray(),
      db.settings.get('default'),
    ]);
    setAccounts(accList);
    setTransactions(txList);
    setRules(ruleList);
    if (savedSettings) {
      setSettings(savedSettings);
      setMovingAverageWindow(savedSettings.movingAverageWindow || 3);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await ensureInitialSeedData(db);
        if (mounted) {
          await reloadFromIndexedDB();
        }
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [reloadFromIndexedDB]);

  const analytics = useMemo(
    () =>
      calculateFinancialAnalytics(
        transactions,
        datePreset,
        movingAverageWindow,
        selectedAccountId
      ),
    [transactions, datePreset, movingAverageWindow, selectedAccountId]
  );

  const unknownMerchantCount = useMemo(() => {
    const rulesMap = new Map(rules.map((r) => [r.sanitizedPattern, r]));
    const set = new Set<string>();
    for (const tx of transactions) {
      if (!rulesMap.has(tx.sanitizedMerchant)) {
        set.add(tx.sanitizedMerchant);
      }
    }
    return set.size;
  }, [transactions, rules]);

  const handleImportTransactions = async (newRecords: TransactionRecord[]) => {
    await db.transactions.bulkPut(newRecords);
    await reloadFromIndexedDB();
  };

  const handleAddManualTransaction = async (record: TransactionRecord) => {
    await db.transactions.put(record);
    await reloadFromIndexedDB();
  };

  const handleUpdateTransactionAndRule = async (
    tx: TransactionRecord,
    updates: {
      category: TransactionCategory;
      direction: TransactionDirection;
      costStructure: CostStructureTag;
      necessity: NecessityTag;
      cadence: CadenceTag;
      userNotes?: string;
    },
    saveToRuleCache: boolean
  ) => {
    const updatedTx: TransactionRecord = {
      ...tx,
      category: updates.category,
      direction: updates.direction,
      costStructure: updates.costStructure,
      necessity: updates.necessity,
      cadence: updates.cadence,
      userNotes: updates.userNotes,
      ruleSource: 'manual',
      isCorrected: true,
    };

    await db.transactions.put(updatedTx);

    if (saveToRuleCache) {
      const rule: MerchantRule = {
        sanitizedPattern: tx.sanitizedMerchant,
        category: updates.category,
        costStructure: updates.costStructure,
        necessity: updates.necessity,
        cadence: updates.cadence,
        source: 'manual',
        matchCount: 1,
        updatedAt: new Date().toISOString(),
      };
      await db.rules.put(rule);

      // Retroactively update other transactions sharing the same sanitizedMerchant
      const matching = await db.transactions
        .where('sanitizedMerchant')
        .equals(tx.sanitizedMerchant)
        .toArray();

      const bulkUpdated = matching.map((item) => ({
        ...item,
        category: updates.category,
        costStructure: updates.costStructure,
        necessity: updates.necessity,
        cadence: updates.cadence,
        ruleSource: item.id === tx.id ? ('manual' as const) : ('cache' as const),
      }));
      await db.transactions.bulkPut(bulkUpdated);
    }

    await reloadFromIndexedDB();
  };

  const handleSaveRulesAndApply = async (newRules: MerchantRule[]) => {
    await db.rules.bulkPut(newRules);
    const rulesByPattern = new Map(newRules.map((r) => [r.sanitizedPattern, r]));

    const allTxs = await db.transactions.toArray();
    const toUpdate: TransactionRecord[] = [];
    for (const tx of allTxs) {
      const matched = rulesByPattern.get(tx.sanitizedMerchant);
      if (matched) {
        toUpdate.push({
          ...tx,
          category: matched.category,
          costStructure: matched.costStructure,
          necessity: matched.necessity,
          cadence: matched.cadence,
          ruleSource: matched.source === 'manual' ? 'manual' : 'cache',
        });
      }
    }
    if (toUpdate.length > 0) {
      await db.transactions.bulkPut(toUpdate);
    }
    await reloadFromIndexedDB();
  };

  const handleDeleteRule = async (sanitizedPattern: string) => {
    await db.rules.delete(sanitizedPattern);
    await reloadFromIndexedDB();
  };

  const handleToggleLlmConsent = async (granted: boolean) => {
    const updated: AppSettings = { ...settings, llmConsentGranted: granted };
    await db.settings.put(updated);
    setSettings(updated);
  };

  const handleChangeMovingAverageWindow = async (w: number) => {
    setMovingAverageWindow(w);
    const updated: AppSettings = { ...settings, movingAverageWindow: w };
    await db.settings.put(updated);
    setSettings(updated);
  };

  const handleAddAccount = async (account: BankAccount) => {
    await db.accounts.put(account);
    await reloadFromIndexedDB();
  };

  const handleRestoreBackup = async (payload: PlainBackupPayload) => {
    await clearAllLocalData(db);
    if (payload.accounts?.length) await db.accounts.bulkPut(payload.accounts);
    if (payload.transactions?.length) await db.transactions.bulkPut(payload.transactions);
    if (payload.rules?.length) await db.rules.bulkPut(payload.rules);
    if (payload.settings) await db.settings.put(payload.settings);
    await reloadFromIndexedDB();
  };

  const handleClearAllData = async () => {
    await clearAllLocalData(db);
    await reloadFromIndexedDB();
  };

  const handleClearTransactionsOnly = async () => {
    await clearTransactionsOnly(db);
    await reloadFromIndexedDB();
  };

  const handleDeleteTransaction = async (txId: string) => {
    await db.transactions.delete(txId);
    await reloadFromIndexedDB();
  };

  const handleReseedDemoData = async () => {
    await clearAllLocalData(db);
    await ensureInitialSeedData(db, true);
    await reloadFromIndexedDB();
  };

  const navigateTo = (section: ActiveSection) => {
    setActiveSection(section);
    setMobileMenuOpen(false);
  };

  const triggerImportCsvCta = () => {
    navigateTo('import');
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900 pb-20 lg:pb-0">
      {/* Top Header Bar (Responsive for Mobile & Desktop) */}
      <header className="sticky top-0 z-40 bg-white border-b border-slate-200">
        <div className="max-w-[1360px] mx-auto flex items-center justify-between gap-3 px-4 sm:px-6 py-3.5">
          {/* Zone 1: Brand Wordmark */}
          <a
            href="#overview"
            onClick={(e) => {
              e.preventDefault();
              navigateTo('overview');
            }}
            className="text-lg font-bold tracking-tight text-slate-900 font-display whitespace-nowrap shrink-0"
          >
            bankingBuddy
          </a>

          {/* Zone 2: Desktop Navigation Links */}
          <nav className="hidden lg:flex items-center gap-6 text-sm font-medium text-slate-600">
            {NAV_ITEMS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigateTo(item.id);
                }}
                className={`transition-colors whitespace-nowrap shrink-0 pb-0.5 ${
                  activeSection === item.id
                    ? 'text-slate-900 border-b-2 border-slate-900 font-semibold'
                    : 'hover:text-slate-900'
                }`}
              >
                {item.label}
                {item.id === 'llm_debug' && unknownMerchantCount > 0
                  ? ` (${unknownMerchantCount})`
                  : ''}
              </a>
            ))}
          </nav>

          {/* Zone 3: Primary Action + Mobile Menu Toggle Button */}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={triggerImportCsvCta}
              className="px-3 sm:px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
            >
              Import CSV
            </button>

            <button
              type="button"
              onClick={() => setMobileMenuOpen((prev) => !prev)}
              aria-expanded={mobileMenuOpen}
              aria-label="Toggle navigation menu"
              className="lg:hidden inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors"
            >
              {mobileMenuOpen ? (
                <>
                  <X className="w-4 h-4" />
                  <span>Close</span>
                </>
              ) : (
                <>
                  <Menu className="w-4 h-4" />
                  <span>Menu</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Always-Visible Mobile Quick Tab Strip (scrollable buttons on mobile/tablet) */}
        <div className="lg:hidden border-t border-slate-100 bg-slate-50/90 px-3 py-2 overflow-x-auto">
          <div className="flex items-center gap-1.5 min-w-max">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    isActive
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.label}</span>
                  {item.id === 'llm_debug' && unknownMerchantCount > 0 && (
                    <span
                      className={`font-mono text-[10px] px-1.5 py-0.2 rounded ${
                        isActive ? 'bg-amber-400 text-slate-950' : 'bg-amber-100 text-amber-900'
                      }`}
                    >
                      {unknownMerchantCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Expandable Mobile Navigation Drawer (when Menu button is tapped) */}
        {mobileMenuOpen && (
          <div className="lg:hidden border-t border-slate-200 bg-white px-4 py-3 shadow-lg space-y-1.5">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeSection === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => navigateTo(item.id)}
                  className={`w-full flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl text-left transition-colors ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Icon className="w-4 h-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{item.label}</div>
                      <div
                        className={`text-[11px] truncate ${
                          isActive ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {item.description}
                      </div>
                    </div>
                  </div>
                  {item.id === 'llm_debug' && unknownMerchantCount > 0 && (
                    <span className="px-2 py-0.5 text-[11px] font-mono font-semibold rounded bg-amber-400 text-slate-950 shrink-0">
                      {unknownMerchantCount} uncached
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </header>

      {/* Main Content Container */}
      <main className="flex-1 max-w-[1360px] w-full mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {isLoading ? (
          <div className="space-y-4">
            <div className="h-8 w-64 bg-slate-200 rounded animate-pulse" />
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="h-28 bg-slate-200 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-200 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-200 rounded-xl animate-pulse" />
              <div className="h-28 bg-slate-200 rounded-xl animate-pulse" />
            </div>
            <div className="h-80 bg-slate-200 rounded-xl animate-pulse" />
          </div>
        ) : (
          <>
            {activeSection === 'overview' && (
              <TrendAnalyticsView
                analytics={analytics}
                accounts={accounts}
                selectedAccountId={selectedAccountId}
                onSelectAccount={setSelectedAccountId}
                datePreset={datePreset}
                onSelectDatePreset={setDatePreset}
                movingAverageWindow={movingAverageWindow}
                onChangeMovingAverageWindow={handleChangeMovingAverageWindow}
                baseCurrency={settings.baseCurrency}
                unknownMerchantCount={unknownMerchantCount}
                totalTransactionCount={transactions.length}
                onNavigateToRules={() => navigateTo('llm_debug')}
                onOpenCsvImport={triggerImportCsvCta}
                onClearTransactions={handleClearTransactionsOnly}
                onReseedDemoData={handleReseedDemoData}
              />
            )}

            {(activeSection === 'table' || activeSection === 'import') && (
              <LedgerAndImportView
                transactions={transactions}
                accounts={accounts}
                rules={rules}
                exchangeRatesToEur={settings.exchangeRatesToEur}
                initialMode={activeSection === 'import' ? 'import' : 'table'}
                unknownMerchantCount={unknownMerchantCount}
                onNavigateToLlmDebug={() => navigateTo('llm_debug')}
                onImportTransactions={handleImportTransactions}
                onUpdateTransactionAndRule={handleUpdateTransactionAndRule}
                onAddManualTransaction={handleAddManualTransaction}
                onClearTransactions={handleClearTransactionsOnly}
                onDeleteTransaction={handleDeleteTransaction}
                onReseedDemoData={handleReseedDemoData}
              />
            )}

            {activeSection === 'llm_debug' && (
              <LlmDebugAndApprovalView
                transactions={transactions}
                rules={rules}
                llmConsentGranted={settings.llmConsentGranted}
                onToggleLlmConsent={handleToggleLlmConsent}
                onSaveRulesAndApply={handleSaveRulesAndApply}
                onDeleteRule={handleDeleteRule}
              />
            )}

            {activeSection === 'backups' && (
              <div className="space-y-10">
                <BackupAndStorageView
                  accounts={accounts}
                  transactions={transactions}
                  rules={rules}
                  settings={settings}
                  onAddAccount={handleAddAccount}
                  onRestoreBackup={handleRestoreBackup}
                  onClearAllData={handleClearAllData}
                  onReseedDemoData={handleReseedDemoData}
                />
                <div className="pt-8 border-t border-slate-200">
                  <ArchitectureAndTestsView />
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Quiet Footer */}
      <footer className="border-t border-slate-200 bg-white px-4 sm:px-6 py-4 text-xs text-slate-500">
        <div className="max-w-[1360px] mx-auto flex flex-wrap items-center justify-between gap-4">
          <span>
            bankingBuddy · Local-first IndexedDB storage (`bankingBuddyLocalDB` Schema v2) · Web & Android WebViewAssetLoader
          </span>
          <span className="font-mono tabular-nums">
            {accounts.length} accounts · {transactions.length} transactions · {rules.length} cached merchant rules
          </span>
        </div>
      </footer>

      {/* Fixed Mobile Bottom Navigation Bar (Thumb-friendly for Android WebView & Mobile Browsers) */}
      <nav
        aria-label="Mobile Bottom Navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-slate-200 shadow-lg"
      >
        <div className="grid grid-cols-5 h-16">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`relative flex flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                  isActive
                    ? 'text-slate-950 font-semibold bg-slate-100/80'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-4 h-4 ${isActive ? 'text-slate-950' : 'text-slate-500'}`} />
                <span className="truncate max-w-[68px]">{item.shortLabel}</span>
                {item.id === 'llm_debug' && unknownMerchantCount > 0 && (
                  <span className="absolute top-1.5 right-3 w-2 h-2 rounded-full bg-amber-500" />
                )}
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
