import React, { useState, useMemo, useEffect } from 'react';
import {
  BankAccount,
  CadenceTag,
  CostStructureTag,
  CsvColumnMapping,
  MerchantRule,
  NecessityTag,
  SavedCsvMappingPreset,
  SupportedCurrency,
  TransactionCategory,
  TransactionDirection,
  TransactionRecord,
} from '../lib/types';
import {
  decodeCsvBuffer,
  extractCsvStructure,
  inferColumnMapping,
  processCsvImport,
} from '../lib/csvEngine';
import {
  Upload,
  Search,
  FileSpreadsheet,
  Check,
  Eye,
  Plus,
  SlidersHorizontal,
  Save,
  RotateCcw,
  Trash2,
} from 'lucide-react';

const ALL_CATEGORIES: TransactionCategory[] = [
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

const SAMPLE_GERMAN_SPARKASSE_CSV = `Buchungstag;Valutadatum;Buchungstext;Beguenstigter/Zahlungspflichtiger;Verwendungszweck;Betrag;Waehrung
24.10.2026;24.10.2026;Kartenzahlung;REWE Markt GmbH;REWE MARKT 48.20 EUR 24.10 KARTENZAHLUNG;-48,20;EUR
23.10.2026;23.10.2026;Lastschrift;DB Vertrieb GmbH;DEUTSCHE BAHN FERNVERKEHR ICE TICKET 23.10.2026;-89,90;EUR
22.10.2026;22.10.2026;Kartenzahlung;BIO COMPANY Berlin;BIO COMPANY FILIALE 14 22.10.2026 31,45 EUR;-31,45;EUR
20.10.2026;20.10.2026;Gutschrift;Zalando SE;ZALANDO SE GUTSCHRIFT RETOURE 9948219;59,90;EUR
19.10.2026;19.10.2026;Umbuchung;Tagesgeld Sparkonto;UMBUCHUNG EIGENÜBERWEISUNG DE89370400440532013000;-400,00;EUR
17.10.2026;17.10.2026;Kartenzahlung;Kiez Kaffeeroesterei;KIEZ KAFFEEROESTEREI BERLIN 18,50 EUR 17.10;-18,50;EUR
15.10.2026;15.10.2026;Lastschrift;Buchhandlung am Markt;BUCHHANDLUNG AM MARKT RG 2026-8812;-26,00;EUR`;

const SAMPLE_SPLIT_DEBIT_CREDIT_CSV = `Bank Statement Export;Account: DE89370400440532013000;;;;;
Exported At: 2026-10-25;;;;;;
Transaction Date;Merchant Name;Payment Reference;Debit (Soll);Credit (Haben);Curr;Booking Type
2026-10-24;ALNATURA BIO MARKT;ALNATURA FILIALE 08 KARTENZAHLUNG 24.10;64.30;;EUR;Card Payment
2026-10-23;APPLE.COM/BILL;ICLOUD STORAGE 2TB SUBSCRIPTION 23.10;9.99;;EUR;Direct Debit
2026-10-21;FREELANCE CLIENT GMBH;INVOICE 2026-104 CONSULTING HONORAR;;1450.00;EUR;SEPA Credit
2026-10-19;AMAZON EU SARL;AMAZON RETOURE ERSTATTUNG ORDER 304-991;;39.99;EUR;Refund`;

const PRESETS_STORAGE_KEY = 'bankingBuddy_csv_mapping_presets_v1';

type ColumnRole =
  | 'IGNORE'
  | 'BOOKING_DATE'
  | 'DESCRIPTION'
  | 'COUNTERPARTY'
  | 'AMOUNT_SINGLE'
  | 'DEBIT'
  | 'CREDIT'
  | 'CURRENCY'
  | 'TYPE';

interface LedgerAndImportViewProps {
  transactions: TransactionRecord[];
  accounts: BankAccount[];
  rules: MerchantRule[];
  exchangeRatesToEur: Record<SupportedCurrency, number>;
  initialMode?: 'table' | 'import';
  unknownMerchantCount?: number;
  onNavigateToLlmDebug?: () => void;
  onImportTransactions: (records: TransactionRecord[]) => Promise<void>;
  onUpdateTransactionAndRule: (
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
  ) => Promise<void>;
  onAddManualTransaction: (tx: TransactionRecord) => Promise<void>;
  onClearTransactions: () => Promise<void>;
  onDeleteTransaction: (txId: string) => Promise<void>;
  onReseedDemoData: () => Promise<void>;
}

export const LedgerAndImportView: React.FC<LedgerAndImportViewProps> = ({
  transactions,
  accounts,
  rules,
  exchangeRatesToEur,
  initialMode = 'table',
  unknownMerchantCount = 0,
  onNavigateToLlmDebug,
  onImportTransactions,
  onUpdateTransactionAndRule,
  onAddManualTransaction,
  onClearTransactions,
  onDeleteTransaction,
  onReseedDemoData,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [directionFilter, setDirectionFilter] = useState<string>('ALL');
  const [ruleSourceFilter, setRuleSourceFilter] = useState<string>('ALL');
  const [showImportPanel, setShowImportPanel] = useState(initialMode === 'import');
  const [showManualForm, setShowManualForm] = useState(false);
  const [confirmClearLedger, setConfirmClearLedger] = useState(false);
  const [syncInlineEditsToRules, setSyncInlineEditsToRules] = useState(true);
  const [inlineSaveNotice, setInlineSaveNotice] = useState<string | null>(null);

  useEffect(() => {
    setShowImportPanel(initialMode === 'import');
  }, [initialMode]);

  // CSV Import & Manual Column Matching State
  const [rawBuffer, setRawBuffer] = useState<ArrayBuffer | null>(null);
  const [csvText, setCsvText] = useState<string>('');
  const [detectedEncoding, setDetectedEncoding] = useState<'UTF-8' | 'WINDOWS-1252'>('UTF-8');
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [sampleRows, setSampleRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<CsvColumnMapping | null>(null);
  const [targetAccountId, setTargetAccountId] = useState<string>(accounts[0]?.id || 'acc_dkb_giro');
  const [importFeedback, setImportFeedback] = useState<string | null>(null);

  // Saved Column Mapping Presets
  const [savedPresets, setSavedPresets] = useState<SavedCsvMappingPreset[]>(() => {
    try {
      const raw = localStorage.getItem(PRESETS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [presetNameInput, setPresetNameInput] = useState('');

  // Editing / Inspecting single transaction
  const [inspectingTx, setInspectingTx] = useState<TransactionRecord | null>(null);
  const [editCategory, setEditCategory] = useState<TransactionCategory>('Groceries');
  const [editDirection, setEditDirection] = useState<TransactionDirection>('expense');
  const [editCostStructure, setEditCostStructure] = useState<CostStructureTag>('Variable');
  const [editNecessity, setEditNecessity] = useState<NecessityTag>('Essential');
  const [editCadence, setEditCadence] = useState<CadenceTag>('Recurring');
  const [editNotes, setEditNotes] = useState<string>('');
  const [applyToRuleCache, setApplyToRuleCache] = useState<boolean>(true);

  // Manual Entry State
  const [manualDate, setManualDate] = useState('2026-10-25');
  const [manualDesc, setManualDesc] = useState('');
  const [manualAmount, setManualAmount] = useState('-24.50');
  const [manualAccountId] = useState(accounts[0]?.id || 'acc_dkb_giro');

  const loadCsvIntoPreview = (
    rawText: string,
    encoding: 'UTF-8' | 'WINDOWS-1252' = 'UTF-8',
    manualHeaderOffset?: number
  ) => {
    setCsvText(rawText);
    setDetectedEncoding(encoding);
    const structure = extractCsvStructure(rawText, manualHeaderOffset);
    setCsvHeaders(structure.headers);
    setSampleRows(structure.sampleRows);
    const inferred = inferColumnMapping(structure.headers, structure.detectedHeaderRowOffset);
    setMapping(inferred);
    setImportFeedback(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    setRawBuffer(buffer);
    const { text, detectedEncoding: enc } = decodeCsvBuffer(buffer, 'AUTO');
    loadCsvIntoPreview(text, enc);
  };

  const handleChangeEncodingOverride = (encOverride: 'AUTO' | 'UTF-8' | 'WINDOWS-1252') => {
    if (!mapping) return;
    if (rawBuffer) {
      const { text, detectedEncoding: enc } = decodeCsvBuffer(rawBuffer, encOverride);
      setCsvText(text);
      setDetectedEncoding(enc);
      const structure = extractCsvStructure(text, mapping.headerRowOffset);
      setCsvHeaders(structure.headers);
      setSampleRows(structure.sampleRows);
    }
    setMapping({ ...mapping, encoding: encOverride });
  };

  const handleChangeHeaderOffset = (newOffset: number) => {
    if (!csvText || !mapping) return;
    const clamped = Math.max(0, Math.min(20, newOffset));
    const structure = extractCsvStructure(csvText, clamped);
    setCsvHeaders(structure.headers);
    setSampleRows(structure.sampleRows);
    const reInferred = inferColumnMapping(structure.headers, clamped);
    setMapping({
      ...reInferred,
      dateFormat: mapping.dateFormat,
      decimalFormat: mapping.decimalFormat,
      encoding: mapping.encoding,
      headerRowOffset: clamped,
    });
  };

  // Determine which role a given CSV column header is currently assigned to
  const getColumnRole = (headerName: string): ColumnRole => {
    if (!mapping) return 'IGNORE';
    if (mapping.bookingDateCol === headerName) return 'BOOKING_DATE';
    if (mapping.descriptionCol === headerName) return 'DESCRIPTION';
    if (mapping.counterpartyCol === headerName) return 'COUNTERPARTY';
    if (mapping.amountMode !== 'SPLIT' && mapping.amountCol === headerName) return 'AMOUNT_SINGLE';
    if (mapping.amountMode === 'SPLIT' && mapping.debitCol === headerName) return 'DEBIT';
    if (mapping.amountMode === 'SPLIT' && mapping.creditCol === headerName) return 'CREDIT';
    if (mapping.currencyCol === headerName) return 'CURRENCY';
    if (mapping.typeCol === headerName) return 'TYPE';
    return 'IGNORE';
  };

  // Assign a CSV column header to a role directly from the Interactive Column Matcher table
  const assignColumnRole = (headerName: string, role: ColumnRole) => {
    if (!mapping) return;
    const next: CsvColumnMapping = { ...mapping };

    // Clear previous assignment if this column was already assigned elsewhere
    if (next.bookingDateCol === headerName && role !== 'BOOKING_DATE') next.bookingDateCol = '';
    if (next.descriptionCol === headerName && role !== 'DESCRIPTION') next.descriptionCol = '';
    if (next.counterpartyCol === headerName && role !== 'COUNTERPARTY') next.counterpartyCol = undefined;
    if (next.amountCol === headerName && role !== 'AMOUNT_SINGLE') next.amountCol = '';
    if (next.debitCol === headerName && role !== 'DEBIT') next.debitCol = undefined;
    if (next.creditCol === headerName && role !== 'CREDIT') next.creditCol = undefined;
    if (next.currencyCol === headerName && role !== 'CURRENCY') next.currencyCol = undefined;
    if (next.typeCol === headerName && role !== 'TYPE') next.typeCol = undefined;

    switch (role) {
      case 'BOOKING_DATE':
        next.bookingDateCol = headerName;
        break;
      case 'DESCRIPTION':
        next.descriptionCol = headerName;
        break;
      case 'COUNTERPARTY':
        next.counterpartyCol = headerName;
        break;
      case 'AMOUNT_SINGLE':
        next.amountMode = 'SINGLE';
        next.amountCol = headerName;
        break;
      case 'DEBIT':
        next.amountMode = 'SPLIT';
        next.debitCol = headerName;
        break;
      case 'CREDIT':
        next.amountMode = 'SPLIT';
        next.creditCol = headerName;
        break;
      case 'CURRENCY':
        next.currencyCol = headerName;
        break;
      case 'TYPE':
        next.typeCol = headerName;
        break;
      case 'IGNORE':
      default:
        break;
    }

    setMapping(next);
  };

  const handleSaveMappingPreset = () => {
    if (!mapping || !presetNameInput.trim()) return;
    const newPreset: SavedCsvMappingPreset = {
      id: `preset_${Date.now()}`,
      name: presetNameInput.trim(),
      mapping: { ...mapping },
      createdAt: new Date().toISOString(),
    };
    const updated = [...savedPresets, newPreset];
    setSavedPresets(updated);
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updated));
    setPresetNameInput('');
  };

  const handleApplyPreset = (preset: SavedCsvMappingPreset) => {
    if (csvText && typeof preset.mapping.headerRowOffset === 'number') {
      const structure = extractCsvStructure(csvText, preset.mapping.headerRowOffset);
      setCsvHeaders(structure.headers);
      setSampleRows(structure.sampleRows);
    }
    setMapping({ ...preset.mapping });
  };

  const handleDeletePreset = (id: string) => {
    const updated = savedPresets.filter((p) => p.id !== id);
    setSavedPresets(updated);
    localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(updated));
  };

  const previewImportResult = useMemo(() => {
    if (!csvText || !mapping) return null;
    const targetAcc = accounts.find((a) => a.id === targetAccountId) || accounts[0];
    if (!targetAcc) return null;

    const existingFp = new Set(transactions.map((t) => t.fingerprint));
    const rulesMap = new Map(rules.map((r) => [r.sanitizedPattern, r]));
    return processCsvImport(
      csvText,
      mapping,
      targetAcc,
      existingFp,
      rulesMap,
      exchangeRatesToEur
    );
  }, [csvText, mapping, targetAccountId, accounts, transactions, rules, exchangeRatesToEur]);

  const handleCommitCsvImport = async () => {
    if (!previewImportResult || previewImportResult.importedRecords.length === 0) return;
    await onImportTransactions(previewImportResult.importedRecords);
    setImportFeedback(
      `Imported ${previewImportResult.importedRecords.length} transactions (${previewImportResult.duplicateCount} duplicates skipped).`
    );
    setCsvText('');
    setMapping(null);
  };

  const filteredTransactions = useMemo(() => {
    return transactions
      .filter((tx) => {
        if (categoryFilter !== 'ALL' && tx.category !== categoryFilter) return false;
        if (directionFilter !== 'ALL' && tx.direction !== directionFilter) return false;
        if (ruleSourceFilter !== 'ALL' && tx.ruleSource !== ruleSourceFilter) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            tx.sanitizedMerchant.toLowerCase().includes(q) ||
            tx.rawDescription.toLowerCase().includes(q) ||
            tx.category.toLowerCase().includes(q) ||
            tx.bookingDate.includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => b.bookingDate.localeCompare(a.bookingDate));
  }, [transactions, categoryFilter, directionFilter, ruleSourceFilter, searchQuery]);

  const handleInlineRowUpdate = async (
    tx: TransactionRecord,
    patch: Partial<{
      category: TransactionCategory;
      direction: TransactionDirection;
      costStructure: CostStructureTag;
      necessity: NecessityTag;
      cadence: CadenceTag;
    }>
  ) => {
    const nextCategory = patch.category ?? tx.category;
    const nextDirection = patch.direction ?? tx.direction;
    const nextCostStructure = patch.costStructure ?? tx.costStructure;
    const nextNecessity = patch.necessity ?? tx.necessity;
    const nextCadence = patch.cadence ?? tx.cadence;

    await onUpdateTransactionAndRule(
      tx,
      {
        category: nextCategory,
        direction: nextDirection,
        costStructure: nextCostStructure,
        necessity: nextNecessity,
        cadence: nextCadence,
        userNotes: tx.userNotes,
      },
      syncInlineEditsToRules
    );

    setInlineSaveNotice(
      syncInlineEditsToRules
        ? `Saved "${tx.sanitizedMerchant}" → ${nextCategory} (${nextCostStructure}, ${nextNecessity}, ${nextCadence}) & updated Local Rule Cache`
        : `Updated single transaction line "${tx.sanitizedMerchant}" → ${nextCategory}`
    );
  };

  const openInspector = (tx: TransactionRecord) => {
    setInspectingTx(tx);
    setEditCategory(tx.category);
    setEditDirection(tx.direction);
    setEditCostStructure(tx.costStructure);
    setEditNecessity(tx.necessity);
    setEditCadence(tx.cadence);
    setEditNotes(tx.userNotes || '');
    setApplyToRuleCache(true);
  };

  const handleSaveInspector = async () => {
    if (!inspectingTx) return;
    await onUpdateTransactionAndRule(
      inspectingTx,
      {
        category: editCategory,
        direction: editDirection,
        costStructure: editCostStructure,
        necessity: editNecessity,
        cadence: editCadence,
        userNotes: editNotes.trim() || undefined,
      },
      applyToRuleCache
    );
    setInspectingTx(null);
  };

  const handleCreateManualTx = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualDesc.trim()) return;
    const targetAcc = accounts.find((a) => a.id === manualAccountId) || accounts[0];
    if (!targetAcc) return;
    const csvSnippet = `Buchungstag;Verwendungszweck;Betrag;Waehrung\n${manualDate};${manualDesc};${manualAmount};${targetAcc.currency}`;
    const m = inferColumnMapping(['Buchungstag', 'Verwendungszweck', 'Betrag', 'Waehrung']);
    const existingFp = new Set(transactions.map((t) => t.fingerprint));
    const rulesMap = new Map(rules.map((r) => [r.sanitizedPattern, r]));
    const batch = processCsvImport(csvSnippet, m, targetAcc, existingFp, rulesMap, exchangeRatesToEur);
    if (batch.importedRecords[0]) {
      await onAddManualTransaction(batch.importedRecords[0]);
      setManualDesc('');
      setShowManualForm(false);
    }
  };

  const accountNameMap = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts]
  );

  return (
    <div className="space-y-6">
      {/* Header & Action Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-5 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            {showImportPanel
              ? 'CSV Import & Manual Column Matching Workbench'
              : 'Transactions Table & Inline Category Editor'}
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {showImportPanel
              ? 'Map any bank CSV schema (Single Amount or Split Debit/Credit, custom date/decimal formats, header offsets) locally'
              : 'Inspect individual transaction lines and edit AI/rule-assigned categories and multi-dimensional tags directly inline'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {onNavigateToLlmDebug && (
            <button
              type="button"
              onClick={onNavigateToLlmDebug}
              className="px-3.5 py-2 text-xs font-medium text-amber-900 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              LLM Debug & Approval Queue ({unknownMerchantCount} uncached)
            </button>
          )}

          {transactions.length > 0 ? (
            !confirmClearLedger ? (
              <button
                type="button"
                onClick={() => setConfirmClearLedger(true)}
                className="px-3.5 py-2 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-lg hover:bg-rose-100 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear All Transactions ({transactions.length})
              </button>
            ) : (
              <div className="flex items-center gap-1.5 bg-rose-50 border border-rose-200 p-1 rounded-lg">
                <button
                  type="button"
                  onClick={async () => {
                    await onClearTransactions();
                    setConfirmClearLedger(false);
                    setImportFeedback('Cleared all transactions from local IndexedDB. Your accounts and merchant rules are ready for your own CSV.');
                  }}
                  className="px-2.5 py-1 text-xs font-medium text-white bg-rose-700 hover:bg-rose-800 rounded-md transition-colors whitespace-nowrap shrink-0"
                >
                  Confirm Clear ({transactions.length})
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearLedger(false)}
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
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Restore Sample Dataset
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowManualForm(!showManualForm)}
            className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Add Single Line
          </button>
          <button
            type="button"
            onClick={() => setShowImportPanel(!showImportPanel)}
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <SlidersHorizontal className="w-3.5 h-3.5" />
            {showImportPanel ? 'Hide CSV Column Matcher' : 'Open CSV Column Matcher'}
          </button>
        </div>
      </div>

      {importFeedback && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-xs text-emerald-900 flex items-center justify-between">
          <span>{importFeedback}</span>
          <button
            type="button"
            onClick={() => setImportFeedback(null)}
            className="text-emerald-700 underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Manual Single Transaction Entry Form */}
      {showManualForm && (
        <form
          onSubmit={handleCreateManualTx}
          className="bg-white border border-slate-200 rounded-xl p-5 grid grid-cols-1 md:grid-cols-5 gap-4 items-end"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Booking Date</label>
            <input
              type="date"
              value={manualDate}
              onChange={(e) => setManualDate(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono"
              required
            />
          </div>
          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Raw Bank Description (will be auto-sanitized)
            </label>
            <input
              type="text"
              placeholder="e.g. REWE MARKT 14.50 EUR 12.03"
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Amount (e.g. -24,50)</label>
            <input
              type="text"
              value={manualAmount}
              onChange={(e) => setManualAmount(e.target.value)}
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg font-mono"
              required
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="w-full px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
            >
              Save Transaction
            </button>
          </div>
        </form>
      )}

      {/* PapaParse CSV Importer & Manual Column Matching Workbench */}
      {showImportPanel && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                CSV Import & Manual Column Matching Workbench
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Upload a CSV or load a sample file below to inspect raw columns, manually assign column roles, or configure split Debit/Credit columns
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => loadCsvIntoPreview(SAMPLE_GERMAN_SPARKASSE_CSV, 'UTF-8')}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Load Sample 1: Sparkasse (Single Amount)
              </button>

              <button
                type="button"
                onClick={() => loadCsvIntoPreview(SAMPLE_SPLIT_DEBIT_CREDIT_CSV, 'UTF-8')}
                className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Load Sample 2: Split Debit/Credit + Header Offset
              </button>

              <label className="px-3.5 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer flex items-center gap-1.5 whitespace-nowrap shrink-0">
                <Upload className="w-3.5 h-3.5" />
                Upload Bank CSV File
                <input
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={handleFileUpload}
                  className="hidden"
                />
              </label>
            </div>
          </div>

          {!mapping ? (
            <div className="p-8 border border-dashed border-slate-300 rounded-xl text-center space-y-2 bg-slate-50/50">
              <div className="text-sm font-medium text-slate-800">
                No CSV File Loaded Yet
              </div>
              <p className="text-xs text-slate-500 max-w-lg mx-auto">
                Click <strong>Upload Bank CSV File</strong> above or click one of the two sample bank CSV buttons to open the interactive Manual Column Matching Workbench.
              </p>
            </div>
          ) : (
            <div className="space-y-6 pt-4 border-t border-slate-100">
              {/* Saved Mapping Presets Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-slate-700">
                    Saved Column Presets:
                  </span>
                  {savedPresets.length === 0 ? (
                    <span className="text-xs text-slate-400">
                      None saved yet — configure columns below and save for 1-click reuse
                    </span>
                  ) : (
                    savedPresets.map((preset) => (
                      <div
                        key={preset.id}
                        className="inline-flex items-center bg-white border border-slate-300 rounded-md overflow-hidden"
                      >
                        <button
                          type="button"
                          onClick={() => handleApplyPreset(preset)}
                          className="px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 transition-colors"
                        >
                          {preset.name}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeletePreset(preset.id)}
                          className="px-1.5 py-1 text-xs text-slate-400 hover:text-rose-600 border-l border-slate-200"
                          title="Delete Preset"
                        >
                          ×
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={presetNameInput}
                    onChange={(e) => setPresetNameInput(e.target.value)}
                    placeholder="Preset name (e.g. DKB Giro)..."
                    className="px-2.5 py-1 text-xs bg-white border border-slate-300 rounded-md"
                  />
                  <button
                    type="button"
                    disabled={!presetNameInput.trim()}
                    onClick={handleSaveMappingPreset}
                    className="px-3 py-1 text-xs font-medium text-slate-800 bg-white border border-slate-300 rounded-md hover:bg-slate-100 disabled:opacity-40 transition-colors inline-flex items-center gap-1"
                  >
                    <Save className="w-3 h-3" />
                    Save Mapping Preset
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setMapping(inferColumnMapping(csvHeaders, mapping.headerRowOffset || 0))
                    }
                    className="px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
                    title="Re-run automatic column detection"
                  >
                    <RotateCcw className="w-3 h-3" />
                    Auto-Match
                  </button>
                </div>
              </div>

              {/* Step 1: Format, Encoding, Amount Mode & Header Offset Controls */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    1. Target Bank Account
                  </label>
                  <select
                    value={targetAccountId}
                    onChange={(e) => setTargetAccountId(e.target.value)}
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    {accounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.currency})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    2. Amount Column Mode
                  </label>
                  <select
                    value={mapping.amountMode || 'SINGLE'}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        amountMode: e.target.value as 'SINGLE' | 'SPLIT',
                      })
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white font-medium"
                  >
                    <option value="SINGLE">Single Signed Column (e.g. Betrag)</option>
                    <option value="SPLIT">Split Debit / Credit Columns (Soll / Haben)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    3. Date Format
                  </label>
                  <select
                    value={mapping.dateFormat}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        dateFormat: e.target.value as CsvColumnMapping['dateFormat'],
                      })
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="AUTO">Auto-Detect (DE / ISO / US)</option>
                    <option value="DD.MM.YYYY">DD.MM.YYYY (German / EU)</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD (ISO 8601)</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY (US Slash)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    4. Number / Decimal Format
                  </label>
                  <select
                    value={mapping.decimalFormat}
                    onChange={(e) =>
                      setMapping({
                        ...mapping,
                        decimalFormat: e.target.value as CsvColumnMapping['decimalFormat'],
                      })
                    }
                    className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="AUTO">Auto-Detect Separator</option>
                    <option value="DE_COMMA">German Comma (1.234,56)</option>
                    <option value="INTL_DOT">International Dot (1,234.56)</option>
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Encoding
                    </label>
                    <select
                      value={mapping.encoding}
                      onChange={(e) =>
                        handleChangeEncodingOverride(
                          e.target.value as 'AUTO' | 'UTF-8' | 'WINDOWS-1252'
                        )
                      }
                      className="w-full px-2 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="AUTO">Auto ({detectedEncoding})</option>
                      <option value="UTF-8">UTF-8</option>
                      <option value="WINDOWS-1252">Win-1252</option>
                    </select>
                  </div>
                  <div>
                    <label
                      className="block text-xs font-medium text-slate-700 mb-1"
                      title="Number of non-table lines to skip at top of file"
                    >
                      Skip Top Lines
                    </label>
                    <input
                      type="number"
                      min={0}
                      max={20}
                      value={mapping.headerRowOffset || 0}
                      onChange={(e) => handleChangeHeaderOffset(Number(e.target.value))}
                      className="w-full px-2.5 py-2 text-xs font-mono border border-slate-300 rounded-lg bg-white"
                    />
                  </div>
                </div>
              </div>

              {/* Step 2: Explicit Target Field Dropdown Selectors */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <div className="text-xs font-semibold text-slate-800">
                  Manual Field Mapping Selectors
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Booking Date (Required) *
                    </label>
                    <select
                      value={mapping.bookingDateCol}
                      onChange={(e) => setMapping({ ...mapping, bookingDateCol: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">— Select Column —</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Description / Purpose *
                    </label>
                    <select
                      value={mapping.descriptionCol}
                      onChange={(e) => setMapping({ ...mapping, descriptionCol: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">— Select Column —</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Counterparty / Payee
                    </label>
                    <select
                      value={mapping.counterpartyCol || ''}
                      onChange={(e) =>
                        setMapping({ ...mapping, counterpartyCol: e.target.value || undefined })
                      }
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">— None / Optional —</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {mapping.amountMode !== 'SPLIT' ? (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Signed Amount Column *
                      </label>
                      <select
                        value={mapping.amountCol}
                        onChange={(e) => setMapping({ ...mapping, amountCol: e.target.value })}
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="">— Select Column —</option>
                        {csvHeaders.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className="block text-[11px] font-medium text-rose-700 mb-1">
                          Debit / Expense (Soll) *
                        </label>
                        <select
                          value={mapping.debitCol || ''}
                          onChange={(e) =>
                            setMapping({ ...mapping, debitCol: e.target.value || undefined })
                          }
                          className="w-full px-2.5 py-1.5 text-xs border border-rose-300 rounded-lg bg-white"
                        >
                          <option value="">— Select Debit —</option>
                          {csvHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-medium text-emerald-700 mb-1">
                          Credit / Income (Haben) *
                        </label>
                        <select
                          value={mapping.creditCol || ''}
                          onChange={(e) =>
                            setMapping({ ...mapping, creditCol: e.target.value || undefined })
                          }
                          className="w-full px-2.5 py-1.5 text-xs border border-emerald-300 rounded-lg bg-white"
                        >
                          <option value="">— Select Credit —</option>
                          {csvHeaders.map((h) => (
                            <option key={h} value={h}>
                              {h}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}

                  <div>
                    <label className="block text-[11px] font-medium text-slate-700 mb-1">
                      Currency Column
                    </label>
                    <select
                      value={mapping.currencyCol || ''}
                      onChange={(e) =>
                        setMapping({ ...mapping, currencyCol: e.target.value || undefined })
                      }
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">— Use Account Default —</option>
                      {csvHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>

                  {mapping.amountMode !== 'SPLIT' && (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-700 mb-1">
                        Booking Type Column
                      </label>
                      <select
                        value={mapping.typeCol || ''}
                        onChange={(e) =>
                          setMapping({ ...mapping, typeCol: e.target.value || undefined })
                        }
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                      >
                        <option value="">— None / Optional —</option>
                        {csvHeaders.map((h) => (
                          <option key={h} value={h}>
                            {h}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>

              {/* Step 3: Interactive Raw CSV Columns & Sample Values Matcher */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-800">
                    Interactive CSV Column Inspector (Assign Role per Detected CSV Column)
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {csvHeaders.length} columns detected at line offset {mapping.headerRowOffset || 0}
                  </div>
                </div>
                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-left border-collapse text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                        <th className="py-2 px-3 font-medium">Detected CSV Header</th>
                        <th className="py-2 px-3 font-medium">Assigned BankingBuddy Role</th>
                        <th className="py-2 px-3 font-medium">Sample Row 1 Value</th>
                        <th className="py-2 px-3 font-medium">Sample Row 2 Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {csvHeaders.map((header) => {
                        const role = getColumnRole(header);
                        const isMapped = role !== 'IGNORE';
                        return (
                          <tr
                            key={header}
                            className={isMapped ? 'bg-slate-50/90' : 'hover:bg-slate-50/40'}
                          >
                            <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                              {header}
                            </td>
                            <td className="py-2 px-3">
                              <select
                                value={role}
                                onChange={(e) =>
                                  assignColumnRole(header, e.target.value as ColumnRole)
                                }
                                className={`px-2.5 py-1 text-xs rounded-md border font-medium ${
                                  isMapped
                                    ? 'bg-slate-900 text-white border-slate-900'
                                    : 'bg-white text-slate-600 border-slate-200'
                                }`}
                              >
                                <option value="IGNORE">Unmapped / Ignore</option>
                                <option value="BOOKING_DATE">Booking Date *</option>
                                <option value="DESCRIPTION">Description / Purpose *</option>
                                <option value="COUNTERPARTY">Counterparty / Merchant</option>
                                <option value="AMOUNT_SINGLE">Amount (Single Signed) *</option>
                                <option value="DEBIT">Debit / Expense (Soll)</option>
                                <option value="CREDIT">Credit / Income (Haben)</option>
                                <option value="CURRENCY">Currency</option>
                                <option value="TYPE">Transaction Type</option>
                              </select>
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-600 max-w-xs truncate">
                              {sampleRows[0]?.[header] || '—'}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-500 max-w-xs truncate">
                              {sampleRows[1]?.[header] || '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Step 4: Live Sanitized Output Preview & Commit */}
              {previewImportResult && (
                <div className="space-y-4 pt-2 border-t border-slate-100">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="text-xs text-slate-600 font-mono tabular-nums">
                      Encoding: {detectedEncoding} · Valid Parsed Rows:{' '}
                      <strong>{previewImportResult.importedRecords.length}</strong> · Duplicates
                      Blocked: {previewImportResult.duplicateCount} · Invalid/Skipped Rows:{' '}
                      {previewImportResult.skippedInvalidRows} · Unique Sanitized Merchants:{' '}
                      {previewImportResult.uniqueSanitizedMerchants.length}
                    </div>

                    <button
                      type="button"
                      disabled={previewImportResult.importedRecords.length === 0}
                      onClick={handleCommitCsvImport}
                      className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 disabled:opacity-40 transition-colors flex items-center gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Commit {previewImportResult.importedRecords.length} Sanitized Rows to IndexedDB
                    </button>
                  </div>

                  <div className="overflow-x-auto border border-slate-200 rounded-lg">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                          <th className="py-2 px-3">Normalized Date</th>
                          <th className="py-2 px-3">Combined Raw Description (Local Only)</th>
                          <th className="py-2 px-3">Sanitized Merchant Pattern</th>
                          <th className="py-2 px-3">Auto-Category & Source</th>
                          <th className="py-2 px-3 text-right">Parsed Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {previewImportResult.importedRecords.slice(0, 8).map((rec) => (
                          <tr key={rec.fingerprint}>
                            <td className="py-2 px-3 font-mono tabular-nums">{rec.bookingDate}</td>
                            <td className="py-2 px-3 text-slate-500 max-w-xs truncate">
                              {rec.rawDescription}
                            </td>
                            <td className="py-2 px-3 font-mono text-slate-900 font-medium">
                              {rec.sanitizedMerchant}
                            </td>
                            <td className="py-2 px-3 text-slate-600">
                              {rec.category} · {rec.direction} · {rec.ruleSource}
                            </td>
                            <td
                              className={`py-2 px-3 text-right font-mono tabular-nums font-medium ${
                                rec.amount >= 0 ? 'text-emerald-700' : 'text-slate-900'
                              }`}
                            >
                              {rec.amount >= 0 ? '+' : ''}
                              {rec.amount.toFixed(2)} {rec.currency}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Search, Filter & Inline Edit Sync Toolbar */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="relative flex-1 min-w-[260px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search individual lines by merchant, raw booking text, category, or YYYY-MM-DD..."
              className="w-full pl-9 pr-4 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:bg-white focus:border-slate-900"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="ALL">All Categories</option>
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>

            <select
              value={ruleSourceFilter}
              onChange={(e) => setRuleSourceFilter(e.target.value)}
              className="px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg text-slate-700"
            >
              <option value="ALL">All Categorization Sources</option>
              <option value="llm">AI / LLM Categorized</option>
              <option value="cache">Local Rule Cache</option>
              <option value="manual">Manual User Edited</option>
              <option value="heuristic">Heuristic Fallback</option>
            </select>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
              {(['ALL', 'expense', 'income', 'refund', 'transfer'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  onClick={() => setDirectionFilter(dir)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors capitalize whitespace-nowrap shrink-0 ${
                    directionFilter === dir
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {dir === 'ALL' ? 'All Types' : dir}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
          <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={syncInlineEditsToRules}
              onChange={(e) => setSyncInlineEditsToRules(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span>
              <strong>Auto-Sync Inline Edits to Rule Cache:</strong> Changing an AI/rule category on any row below also updates matching <span className="font-mono">sanitizedMerchant</span> lines & saves a permanent offline rule
            </span>
          </label>

          <div className="text-slate-500 font-mono tabular-nums">
            Showing {filteredTransactions.length} of {transactions.length} individual lines
          </div>
        </div>

        {inlineSaveNotice && (
          <div className="flex items-center justify-between bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-900">
            <span>{inlineSaveNotice}</span>
            <button
              type="button"
              onClick={() => setInlineSaveNotice(null)}
              className="text-emerald-700 underline ml-3"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {/* Individual Transaction Lines Table with Direct Inline Category & Tag Editing */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-xs text-slate-500">
                <th className="py-3 px-3 font-medium">Date</th>
                <th className="py-3 px-3 font-medium">Individual Line (Sanitized & Raw Bank Text)</th>
                <th className="py-3 px-3 font-medium">Inline Category (Edit AI / Rule Assignment)</th>
                <th className="py-3 px-3 font-medium">Multi-Dimensional Tags (Inline Edit)</th>
                <th className="py-3 px-3 font-medium">Source & Account</th>
                <th className="py-3 px-3 font-medium text-right">Amount</th>
                <th className="py-3 px-3 font-medium text-right">Raw CSV</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-sm">
              {filteredTransactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-slate-50/80 transition-colors align-top">
                  <td className="py-2.5 px-3 font-mono tabular-nums text-xs text-slate-600 whitespace-nowrap">
                    {tx.bookingDate}
                  </td>
                  <td className="py-2.5 px-3 max-w-xs">
                    <div className="font-mono text-xs font-semibold text-slate-900 truncate" title={tx.sanitizedMerchant}>
                      {tx.sanitizedMerchant}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate mt-0.5" title={tx.rawDescription}>
                      Raw: {tx.rawDescription}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 min-w-[205px]">
                    <select
                      aria-label={`Category for ${tx.sanitizedMerchant}`}
                      value={tx.category}
                      onChange={(e) =>
                        handleInlineRowUpdate(tx, {
                          category: e.target.value as TransactionCategory,
                        })
                      }
                      className="w-full px-2.5 py-1.5 text-xs font-medium text-slate-900 bg-white border border-slate-300 rounded-lg hover:border-slate-400 focus:outline-none focus:border-slate-900"
                    >
                      {ALL_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5 px-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <select
                        aria-label={`Type for ${tx.sanitizedMerchant}`}
                        value={tx.direction}
                        onChange={(e) =>
                          handleInlineRowUpdate(tx, {
                            direction: e.target.value as TransactionDirection,
                          })
                        }
                        className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md text-slate-700 hover:border-slate-300"
                      >
                        <option value="expense">expense</option>
                        <option value="income">income</option>
                        <option value="refund">refund</option>
                        <option value="transfer">transfer</option>
                      </select>

                      <select
                        aria-label={`Cost structure for ${tx.sanitizedMerchant}`}
                        value={tx.costStructure}
                        onChange={(e) =>
                          handleInlineRowUpdate(tx, {
                            costStructure: e.target.value as CostStructureTag,
                          })
                        }
                        className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md text-slate-700 hover:border-slate-300"
                      >
                        <option value="Fixed">Fixed</option>
                        <option value="Variable">Variable</option>
                      </select>

                      <select
                        aria-label={`Necessity for ${tx.sanitizedMerchant}`}
                        value={tx.necessity}
                        onChange={(e) =>
                          handleInlineRowUpdate(tx, {
                            necessity: e.target.value as NecessityTag,
                          })
                        }
                        className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md text-slate-700 hover:border-slate-300"
                      >
                        <option value="Essential">Essential</option>
                        <option value="Discretionary">Discretionary</option>
                      </select>

                      <select
                        aria-label={`Cadence for ${tx.sanitizedMerchant}`}
                        value={tx.cadence}
                        onChange={(e) =>
                          handleInlineRowUpdate(tx, {
                            cadence: e.target.value as CadenceTag,
                          })
                        }
                        className="px-2 py-1 text-[11px] bg-slate-50 border border-slate-200 rounded-md text-slate-700 hover:border-slate-300"
                      >
                        <option value="Recurring">Recurring</option>
                        <option value="One-Off">One-Off</option>
                      </select>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-xs text-slate-600 whitespace-nowrap">
                    <div className="font-mono text-[11px] text-slate-700">
                      src: {tx.ruleSource}
                      {tx.isCorrected ? ' (edited)' : ''}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {accountNameMap.get(tx.accountId) || tx.accountId}
                    </div>
                  </td>
                  <td
                    className={`py-2.5 px-3 text-right font-mono tabular-nums text-xs font-semibold whitespace-nowrap ${
                      tx.direction === 'income' || tx.direction === 'refund'
                        ? 'text-emerald-700'
                        : tx.direction === 'transfer'
                          ? 'text-slate-500'
                          : 'text-slate-900'
                    }`}
                  >
                    {tx.amount >= 0 ? '+' : ''}
                    {tx.amount.toFixed(2)} {tx.currency}
                  </td>
                  <td className="py-2.5 px-3 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => openInspector(tx)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 border border-slate-200 rounded-md hover:bg-slate-100 transition-colors inline-flex items-center gap-1"
                    >
                      <Eye className="w-3 h-3" />
                      Audit
                    </button>
                  </td>
                </tr>
              ))}
              {filteredTransactions.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-xs text-slate-500">
                    No matching transaction lines found. Adjust your filters above or import a CSV file.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Transaction Correction & Immutable Raw Audit Modal */}
      {inspectingTx && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-xl w-full p-6 space-y-5 shadow-lg">
            <div className="flex items-start justify-between border-b border-slate-100 pb-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Transaction Correction & Original CSV Audit
                </h3>
                <p className="text-xs text-slate-500 font-mono mt-0.5">
                  Fingerprint: {inspectingTx.fingerprint}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setInspectingTx(null)}
                className="text-xs text-slate-500 hover:text-slate-900"
              >
                Close
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-1">
                <div className="text-slate-500">Sanitized Pattern (Used for Rule Cache & LLM):</div>
                <div className="font-mono font-semibold text-slate-900">
                  {inspectingTx.sanitizedMerchant}
                </div>
                <div className="text-slate-500 pt-2">Original Raw Imported CSV Row (Local IndexedDB Only):</div>
                <pre className="font-mono text-[11px] text-slate-700 overflow-x-auto pt-1">
                  {JSON.stringify(inspectingTx.originalRawRow, null, 2)}
                </pre>
              </div>

              <div className="grid grid-cols-2 gap-3 pt-2">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">Category</label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as TransactionCategory)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    {ALL_CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Transaction Type</label>
                  <select
                    value={editDirection}
                    onChange={(e) => setEditDirection(e.target.value as TransactionDirection)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                    <option value="refund">Refund (Credits Expense)</option>
                    <option value="transfer">Internal Transfer (Neutral)</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Cost Structure</label>
                  <select
                    value={editCostStructure}
                    onChange={(e) => setEditCostStructure(e.target.value as CostStructureTag)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Fixed">Fixed</option>
                    <option value="Variable">Variable</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Necessity</label>
                  <select
                    value={editNecessity}
                    onChange={(e) => setEditNecessity(e.target.value as NecessityTag)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Essential">Essential</option>
                    <option value="Discretionary">Discretionary</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Cadence</label>
                  <select
                    value={editCadence}
                    onChange={(e) => setEditCadence(e.target.value as CadenceTag)}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="Recurring">Recurring</option>
                    <option value="One-Off">One-Off</option>
                  </select>
                </div>

                <div>
                  <label className="block font-medium text-slate-700 mb-1">Local Audit Note</label>
                  <input
                    type="text"
                    value={editNotes}
                    onChange={(e) => setEditNotes(e.target.value)}
                    placeholder="Optional personal note..."
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 pt-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToRuleCache}
                  onChange={(e) => setApplyToRuleCache(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-slate-700">
                  Save to Local Rules Cache so all <strong className="font-mono">{inspectingTx.sanitizedMerchant}</strong> transactions auto-categorize offline
                </span>
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 pt-4 border-t border-slate-100">
              <button
                type="button"
                onClick={async () => {
                  await onDeleteTransaction(inspectingTx.id);
                  setInspectingTx(null);
                }}
                className="px-3 py-2 text-xs font-medium text-rose-700 hover:bg-rose-50 rounded-lg transition-colors inline-flex items-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Delete Transaction
              </button>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setInspectingTx(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSaveInspector}
                  className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors"
                >
                  Save Correction
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
