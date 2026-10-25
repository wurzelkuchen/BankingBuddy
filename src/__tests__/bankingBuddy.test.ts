import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { sanitizeTransactionAudit, sanitizeTransactionDescription } from '../lib/sanitizer';
import {
  computeTransactionFingerprint,
  decodeCsvBuffer,
  detectTransactionDirection,
  extractCsvStructure,
  inferColumnMapping,
  parseFlexibleAmount,
  parseFlexibleDate,
  processCsvImport,
} from '../lib/csvEngine';
import {
  classifyMerchantSync,
  getUnknownUniqueSanitizedMerchants,
} from '../lib/classifier';
import {
  calculateFinancialAnalytics,
  computeMovingAverage,
  generateContinuousPeriods,
} from '../lib/analytics';
import {
  BankingBuddyDB,
  clearAllLocalData,
  DEFAULT_EXCHANGE_RATES,
  ensureInitialSeedData,
} from '../lib/db';
import { createEncryptedBackup, decryptBackupEnvelope } from '../lib/cryptoBackup';
import { BankAccount, MerchantRule } from '../lib/types';

describe('1. Privacy & Sanitization Engine', () => {
  it('strips exact amounts, currencies, and short dates into a single wildcard (*)', () => {
    const result = sanitizeTransactionDescription('REWE MARKT 14.50 EUR 12.03');
    expect(result).toBe('REWE MARKT *');
  });

  it('strips German IBANs, SEPA EREF/MREF tags, and full dates', () => {
    const audit = sanitizeTransactionAudit(
      'SEPA-ELV DE89370400440532013000 EREF+9928172 MREF+11029 REWE SAGT DANKE 12.03.2026 -45,90 EUR'
    );
    expect(audit.sanitized).toBe('SEPA-ELV * REWE SAGT DANKE *');
    expect(audit.sanitized).not.toContain('DE89');
    expect(audit.sanitized).not.toContain('45,90');
    expect(audit.sanitized).not.toContain('12.03.2026');
    expect(audit.strippedTokens.some((t) => t.type === 'IBAN')).toBe(true);
    expect(audit.strippedTokens.some((t) => t.type === 'SEPA_REF')).toBe(true);
  });

  it('strips personal identifiers (Herr/Frau + Name, emails) and flags residual risk on municipal/medical keywords', () => {
    const audit = sanitizeTransactionAudit(
      'ÜBERWEISUNG AN HERR MAX MUSTERMANN PRAXIS DR MED 120,00 EUR max.mustermann@example.com'
    );
    expect(audit.sanitized).not.toContain('MUSTERMANN');
    expect(audit.sanitized).not.toContain('MAX.MUSTERMANN');
    expect(audit.residualRiskLevel).toBe('Medium');
    expect(audit.residualRiskNotes.length).toBeGreaterThan(0);
  });
});

describe('2. CSV Import, Encodings, Formats & Duplicate Detection', () => {
  it('parses German comma decimals and International dot decimals accurately', () => {
    expect(parseFlexibleAmount('1.234,56', 'AUTO')).toBe(1234.56);
    expect(parseFlexibleAmount('-45,90 EUR', 'AUTO')).toBe(-45.9);
    expect(parseFlexibleAmount('120,00-', 'AUTO')).toBe(-120);
    expect(parseFlexibleAmount('1,234.56', 'AUTO')).toBe(1234.56);
    expect(parseFlexibleAmount('-$89.99', 'AUTO')).toBe(-89.99);
  });

  it('parses German DD.MM.YYYY, DD.MM.YY, ISO YYYY-MM-DD, and US MM/DD/YYYY dates', () => {
    expect(parseFlexibleDate('14.03.2026', 'AUTO')).toBe('2026-03-14');
    expect(parseFlexibleDate('05.11.26', 'AUTO')).toBe('2026-11-05');
    expect(parseFlexibleDate('2026-08-21', 'AUTO')).toBe('2026-08-21');
    expect(parseFlexibleDate('09/25/2026', 'MM/DD/YYYY')).toBe('2026-09-25');
  });

  it('auto-detects Windows-1252 / Latin-1 bank CSV encodings with German umlauts', () => {
    // Windows-1252 bytes for "Begünstigter;Währung;Müller" (ü = 0xFC, ä = 0xE4)
    const win1252Bytes = new Uint8Array([
      0x42, 0x65, 0x67, 0xfc, 0x6e, 0x73, 0x74, 0x69, 0x67, 0x74, 0x65, 0x72, 0x3b, 0x57, 0xe4,
      0x68, 0x72, 0x75, 0x6e, 0x67,
    ]);
    const decoded = decodeCsvBuffer(win1252Bytes.buffer, 'AUTO');
    expect(decoded.detectedEncoding).toBe('WINDOWS-1252');
    expect(decoded.text).toBe('Begünstigter;Währung');
  });

  it('detects duplicates across repeated imports while preserving legitimate same-day repeat purchases', () => {
    const account: BankAccount = {
      id: 'acc_test',
      name: 'Test Giro',
      institution: 'Sparkasse',
      accountType: 'Checking',
      currency: 'EUR',
      openingBalance: 1000,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const csvContent = [
      'Buchungstag;Verwendungszweck;Betrag;Waehrung',
      '12.03.2026;REWE MARKT 14.50 EUR 12.03;-14,50;EUR',
      '12.03.2026;REWE MARKT 14.50 EUR 12.03;-14,50;EUR', // Second coffee/snack at same store same day
      '15.03.2026;UMBUCHUNG TAGESGELD SPARPLAN;-300,00;EUR',
      '18.03.2026;ZALANDO SE GUTSCHRIFT RETOURE 9912;49,90;EUR',
    ].join('\n');

    const mapping = inferColumnMapping(['Buchungstag', 'Verwendungszweck', 'Betrag', 'Waehrung']);
    const existingFingerprints = new Set<string>();
    const rulesMap = new Map();

    // First import: both same-day transactions + transfer + refund should import (4 records)
    const firstRun = processCsvImport(
      csvContent,
      mapping,
      account,
      existingFingerprints,
      rulesMap,
      DEFAULT_EXCHANGE_RATES
    );
    expect(firstRun.importedRecords.length).toBe(4);
    expect(firstRun.duplicateCount).toBe(0);
    expect(firstRun.importedRecords[0].sanitizedMerchant).toBe('REWE MARKT *');
    expect(firstRun.importedRecords[2].direction).toBe('transfer');
    expect(firstRun.importedRecords[3].direction).toBe('refund');

    // Second import of the exact same CSV: all 4 rows must be flagged as duplicates
    const secondRun = processCsvImport(
      csvContent,
      mapping,
      account,
      existingFingerprints,
      rulesMap,
      DEFAULT_EXCHANGE_RATES
    );
    expect(secondRun.importedRecords.length).toBe(0);
    expect(secondRun.duplicateCount).toBe(4);
  });

  it('supports manual column matching with split Debit/Credit (Soll/Haben) columns and metadata header offsets', () => {
    const account: BankAccount = {
      id: 'acc_split',
      name: 'Split Column Account',
      institution: 'Volksbank',
      accountType: 'Checking',
      currency: 'EUR',
      openingBalance: 500,
      createdAt: '2026-01-01T00:00:00Z',
    };

    const splitCsvWithMetadata = [
      'Bank Statement Export;Account: DE89370400440532013000;;;;;',
      'Exported At: 2026-10-25;;;;;;',
      'CustomDateCol;MerchantCol;MemoCol;OutflowCol;InflowCol;CurrCol',
      '2026-10-24;ALNATURA BIO;KARTENZAHLUNG 24.10;64,30;;EUR',
      '2026-10-21;FREELANCE CLIENT;INVOICE 104;;1450,00;EUR',
    ].join('\n');

    const structure = extractCsvStructure(splitCsvWithMetadata, 2);
    expect(structure.headers).toContain('CustomDateCol');
    expect(structure.sampleRows.length).toBe(2);

    const manualMapping = {
      bookingDateCol: 'CustomDateCol',
      descriptionCol: 'MemoCol',
      counterpartyCol: 'MerchantCol',
      amountMode: 'SPLIT' as const,
      amountCol: '',
      debitCol: 'OutflowCol',
      creditCol: 'InflowCol',
      currencyCol: 'CurrCol',
      headerRowOffset: 2,
      dateFormat: 'YYYY-MM-DD' as const,
      decimalFormat: 'DE_COMMA' as const,
      encoding: 'UTF-8' as const,
    };

    const batch = processCsvImport(
      splitCsvWithMetadata,
      manualMapping,
      account,
      new Set(),
      new Map(),
      DEFAULT_EXCHANGE_RATES
    );

    expect(batch.importedRecords.length).toBe(2);
    expect(batch.importedRecords[0].amount).toBe(-64.3);
    expect(batch.importedRecords[0].direction).toBe('expense');
    expect(batch.importedRecords[1].amount).toBe(1450);
    expect(batch.importedRecords[1].direction).toBe('income');
  });
});

describe('3. Unique-String Deduplication & Local Rules Cache', () => {
  it('deduplicates recurring sanitized merchant strings so each unique merchant is queued only once', () => {
    const rawDescriptions = [
      'REWE MARKT 14.50 EUR 12.03',
      'REWE MARKT 82.10 EUR 19.03',
      'REWE MARKT 31.00 EUR 25.03',
      'BOULDERKLUB BERLIN 15.00 EUR 14.03',
      'BOULDERKLUB BERLIN 15.00 EUR 21.03',
    ];
    const sanitizedList = rawDescriptions.map((d) => sanitizeTransactionDescription(d));

    const cachedRules = new Map<string, MerchantRule>([
      [
        'REWE MARKT *',
        {
          sanitizedPattern: 'REWE MARKT *',
          category: 'Groceries',
          costStructure: 'Variable',
          necessity: 'Essential',
          cadence: 'Recurring',
          source: 'llm',
          matchCount: 3,
          updatedAt: '2026-03-01T00:00:00Z',
        },
      ],
    ]);

    const unknownUnique = getUnknownUniqueSanitizedMerchants(sanitizedList, cachedRules);
    expect(unknownUnique).toEqual(['BOULDERKLUB BERLIN *']);
  });

  it('classifies common merchants offline via deterministic heuristic rules', () => {
    const res = classifyMerchantSync('REWE MARKT *', -42.5);
    expect(res.category).toBe('Groceries');
    expect(res.necessity).toBe('Essential');
  });
});

describe('4. Financial Analytics, Transfers/Refunds & Moving-Average Trend Line', () => {
  it('computes accurate moving averages and fills missing periods with zero values', () => {
    const series = [100, 200, 300, 600];
    const ma = computeMovingAverage(series, 3);
    expect(ma).toEqual([100, 150, 200, 366.67]);

    const periods = generateContinuousPeriods('2026-01-01', '2026-04-01', 'month');
    expect(periods.map((p) => p.periodKey)).toEqual([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
    ]);
  });

  it('excludes internal transfers from expenses and nets refunds against gross expenses', () => {
    const txs = [
      {
        id: '1',
        fingerprint: computeTransactionFingerprint('acc1', '2026-10-01', 3000, 'SALARY'),
        accountId: 'acc1',
        bookingDate: '2026-10-01',
        amount: 3000,
        currency: 'EUR' as const,
        amountInBaseCurrency: 3000,
        rawDescription: 'SALARY',
        sanitizedMerchant: 'SALARY *',
        direction: 'income' as const,
        category: 'Salary & Income' as const,
        costStructure: 'Fixed' as const,
        necessity: 'Essential' as const,
        cadence: 'Recurring' as const,
        ruleSource: 'heuristic' as const,
        originalRawRow: {},
        importedAt: '2026-10-01',
      },
      {
        id: '2',
        fingerprint: computeTransactionFingerprint('acc1', '2026-10-05', -200, 'ZALANDO'),
        accountId: 'acc1',
        bookingDate: '2026-10-05',
        amount: -200,
        currency: 'EUR' as const,
        amountInBaseCurrency: -200,
        rawDescription: 'ZALANDO',
        sanitizedMerchant: 'ZALANDO *',
        direction: 'expense' as const,
        category: 'Shopping & Retail' as const,
        costStructure: 'Variable' as const,
        necessity: 'Discretionary' as const,
        cadence: 'One-Off' as const,
        ruleSource: 'heuristic' as const,
        originalRawRow: {},
        importedAt: '2026-10-05',
      },
      {
        id: '3',
        fingerprint: computeTransactionFingerprint('acc1', '2026-10-10', 50, 'ZALANDO REFUND'),
        accountId: 'acc1',
        bookingDate: '2026-10-10',
        amount: 50,
        currency: 'EUR' as const,
        amountInBaseCurrency: 50,
        rawDescription: 'ZALANDO REFUND',
        sanitizedMerchant: 'ZALANDO REFUND *',
        direction: 'refund' as const,
        category: 'Shopping & Retail' as const,
        costStructure: 'Variable' as const,
        necessity: 'Discretionary' as const,
        cadence: 'One-Off' as const,
        ruleSource: 'heuristic' as const,
        originalRawRow: {},
        importedAt: '2026-10-10',
      },
      {
        id: '4',
        fingerprint: computeTransactionFingerprint('acc1', '2026-10-15', -500, 'UMBUCHUNG TAGESGELD'),
        accountId: 'acc1',
        bookingDate: '2026-10-15',
        amount: -500,
        currency: 'EUR' as const,
        amountInBaseCurrency: -500,
        rawDescription: 'UMBUCHUNG TAGESGELD',
        sanitizedMerchant: 'UMBUCHUNG TAGESGELD *',
        direction: 'transfer' as const,
        category: 'Internal Transfer' as const,
        costStructure: 'Fixed' as const,
        necessity: 'Essential' as const,
        cadence: 'Recurring' as const,
        ruleSource: 'heuristic' as const,
        originalRawRow: {},
        importedAt: '2026-10-15',
      },
    ];

    const summary = calculateFinancialAnalytics(txs, 'ALL', 3, 'ALL', '2026-10-31');
    expect(summary.totalIncome).toBe(3000);
    expect(summary.grossExpenses).toBe(200);
    expect(summary.totalRefunds).toBe(50);
    expect(summary.netExpenses).toBe(150);
    expect(summary.totalTransfers).toBe(500);
    expect(summary.netCashflow).toBe(2850);

    // Verify per-category and per-dimension line chart series are populated
    const totalShoppingAcrossSeries = summary.timeSeries.reduce(
      (sum, pt) => sum + (pt.categoryExpenses['Shopping & Retail'] || 0),
      0
    );
    expect(totalShoppingAcrossSeries).toBe(150); // 200 gross - 50 refund
    const totalDiscretionaryAcrossSeries = summary.timeSeries.reduce(
      (sum, pt) => sum + pt.discretionaryExpense,
      0
    );
    expect(totalDiscretionaryAcrossSeries).toBe(200);
  });
});

describe('5. Data Safety: IndexedDB Persistence Across Restarts, Encrypted Backups & Clear Data', () => {
  it('persists imported records across simulated app restarts and supports clearAllLocalData', async () => {
    const dbName = `test_restart_db_${Date.now()}`;
    const firstSessionDb = new BankingBuddyDB(dbName);
    await ensureInitialSeedData(firstSessionDb);

    const initialCount = await firstSessionDb.transactions.count();
    expect(initialCount).toBeGreaterThan(20);
    firstSessionDb.close();

    // Simulate app restart by opening a fresh BankingBuddyDB instance on the same IndexedDB store
    const restartedSessionDb = new BankingBuddyDB(dbName);
    const persistedCount = await restartedSessionDb.transactions.count();
    expect(persistedCount).toBe(initialCount);

    // Verify clear-all-data wipes transactions, rules, and accounts
    await clearAllLocalData(restartedSessionDb);
    expect(await restartedSessionDb.transactions.count()).toBe(0);
    expect(await restartedSessionDb.accounts.count()).toBe(0);
    restartedSessionDb.close();
  });

  it('encrypts and decrypts backup payloads with AES-256-GCM + PBKDF2 and rejects wrong passphrases', async () => {
    const samplePayload = {
      version: 2,
      exportedAt: '2026-10-25T00:00:00Z',
      accounts: [
        {
          id: 'acc_1',
          name: 'Main Checking',
          institution: 'DKB',
          accountType: 'Checking' as const,
          currency: 'EUR' as const,
          openingBalance: 2500,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      transactions: [],
      rules: [],
    };

    const envelope = await createEncryptedBackup(samplePayload, 'CorrectHorseBatteryStaple!');
    expect(envelope.cipher).toBe('AES-256-GCM');
    expect(envelope.kdf).toBe('PBKDF2-SHA256');

    const restored = await decryptBackupEnvelope(envelope, 'CorrectHorseBatteryStaple!');
    expect(restored.accounts[0].name).toBe('Main Checking');

    await expect(decryptBackupEnvelope(envelope, 'WrongPassphrase123')).rejects.toThrow();
  });
});
