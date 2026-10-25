export type TransactionCategory =
  | 'Groceries'
  | 'Housing & Utilities'
  | 'Transport & Mobility'
  | 'Dining & Cafes'
  | 'Health & Pharmacy'
  | 'Shopping & Retail'
  | 'Subscriptions & Media'
  | 'Insurance & Finance'
  | 'Salary & Income'
  | 'Internal Transfer'
  | 'Travel & Leisure'
  | 'Other';

export type CostStructureTag = 'Fixed' | 'Variable';
export type NecessityTag = 'Essential' | 'Discretionary';
export type CadenceTag = 'Recurring' | 'One-Off';

export type TransactionDirection = 'income' | 'expense' | 'transfer' | 'refund';

export type SupportedCurrency = 'EUR' | 'USD' | 'GBP' | 'CHF';

export interface MultiDimensionalClassification {
  category: TransactionCategory;
  costStructure: CostStructureTag;
  necessity: NecessityTag;
  cadence: CadenceTag;
  ruleSource: 'manual' | 'cache' | 'llm' | 'heuristic';
  confidence?: number;
}

export interface BankAccount {
  id: string;
  name: string;
  institution: string;
  accountType: 'Checking' | 'Savings' | 'Credit Card' | 'Cash';
  currency: SupportedCurrency;
  ibanLast4?: string;
  openingBalance: number;
  createdAt: string;
}

export interface TransactionRecord {
  id: string;
  fingerprint: string; // Deterministic deduplication hash
  accountId: string;
  bookingDate: string; // ISO YYYY-MM-DD
  valueDate?: string;
  amount: number; // Signed decimal in account currency
  currency: SupportedCurrency;
  amountInBaseCurrency: number; // Normalized to base currency (EUR)
  rawDescription: string; // Preserved locally in IndexedDB only
  counterpartyRaw?: string;
  sanitizedMerchant: string; // Stripped of dates, amounts, IBANs, ref numbers -> wildcards (*)
  direction: TransactionDirection;
  category: TransactionCategory;
  costStructure: CostStructureTag;
  necessity: NecessityTag;
  cadence: CadenceTag;
  ruleSource: 'manual' | 'cache' | 'llm' | 'heuristic';
  userNotes?: string;
  isCorrected?: boolean;
  originalRawRow: Record<string, string>; // Immutable original imported CSV row for local auditability
  importedAt: string;
}

export interface MerchantRule {
  sanitizedPattern: string; // Primary key in IndexedDB
  category: TransactionCategory;
  costStructure: CostStructureTag;
  necessity: NecessityTag;
  cadence: CadenceTag;
  source: 'manual' | 'llm' | 'heuristic';
  matchCount: number;
  updatedAt: string;
}

export interface CsvColumnMapping {
  bookingDateCol: string;
  descriptionCol: string;
  counterpartyCol?: string;
  amountMode?: 'SINGLE' | 'SPLIT';
  amountCol: string;
  debitCol?: string;
  creditCol?: string;
  currencyCol?: string;
  typeCol?: string;
  headerRowOffset?: number; // Number of leading bank metadata lines to skip before header row
  dateFormat: 'AUTO' | 'DD.MM.YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY';
  decimalFormat: 'AUTO' | 'DE_COMMA' | 'INTL_DOT';
  encoding: 'AUTO' | 'UTF-8' | 'WINDOWS-1252';
}

export interface SavedCsvMappingPreset {
  id: string;
  name: string;
  mapping: CsvColumnMapping;
  createdAt: string;
}

export interface SanitizationResult {
  original: string;
  sanitized: string;
  strippedTokens: {
    type: 'IBAN' | 'DATE' | 'AMOUNT' | 'SEPA_REF' | 'CARD_NUMBER' | 'PERSONAL_ID' | 'NUMBER_SEQ';
    value: string;
  }[];
  residualRiskLevel: 'Low' | 'Medium' | 'High';
  residualRiskNotes: string[];
}

export type DateRangePreset = '1M' | '3M' | '6M' | '1Y' | 'ALL';

export interface TimeSeriesPoint {
  periodKey: string; // YYYY-MM-DD or YYYY-MM
  label: string;
  income: number;
  expense: number; // Net of refunds, excluding transfers
  grossExpense: number;
  refunds: number;
  transfers: number;
  netCashflow: number;
  expenseMovingAverage: number;
  incomeMovingAverage: number;
  transactionCount: number;
  categoryExpenses: Record<TransactionCategory, number>;
  fixedExpense: number;
  variableExpense: number;
  essentialExpense: number;
  discretionaryExpense: number;
  recurringExpense: number;
  oneOffExpense: number;
}

export interface CategoryBreakdownItem {
  category: TransactionCategory;
  grossExpense: number;
  refunds: number;
  netExpense: number;
  percentageOfTotal: number;
  transactionCount: number;
}

export interface AnalyticsSummary {
  totalIncome: number;
  grossExpenses: number;
  totalRefunds: number;
  netExpenses: number;
  totalTransfers: number;
  netCashflow: number;
  savingsRate: number;
  fixedExpenses: number;
  variableExpenses: number;
  essentialExpenses: number;
  discretionaryExpenses: number;
  recurringExpenses: number;
  oneOffExpenses: number;
  categoryBreakdown: CategoryBreakdownItem[];
  timeSeries: TimeSeriesPoint[];
  periodGranularity: 'day' | 'month';
  dateRangeStart: string;
  dateRangeEnd: string;
}

export interface AppSettings {
  id: string; // 'default'
  baseCurrency: SupportedCurrency;
  exchangeRatesToEur: Record<SupportedCurrency, number>;
  llmConsentGranted: boolean;
  movingAverageWindow: number;
  lastBackupAt?: string;
  initialSeedCompleted?: boolean;
  schemaVersion: number;
}

export interface EncryptedBackupEnvelope {
  format: 'bankingBuddy-encrypted-v2';
  createdAt: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-256-GCM';
  saltBase64: string;
  ivBase64: string;
  ciphertextBase64: string;
}
