import { sanitizeTransactionAudit, sanitizeTransactionDescription } from './sanitizer';
import {
  computeTransactionFingerprint,
  decodeCsvBuffer,
  inferColumnMapping,
  parseFlexibleAmount,
  parseFlexibleDate,
  processCsvImport,
} from './csvEngine';
import { getUnknownUniqueSanitizedMerchants } from './classifier';
import { calculateFinancialAnalytics, computeMovingAverage } from './analytics';
import { BankingBuddyDB, clearAllLocalData, DEFAULT_EXCHANGE_RATES, ensureInitialSeedData } from './db';
import { createEncryptedBackup, decryptBackupEnvelope } from './cryptoBackup';

export interface InAppTestCaseResult {
  id: string;
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  assertionDetail: string;
}

/**
 * Executes the complete verification suite directly in the browser runtime
 * (testing Sanitization, CSV Encodings/Locales, Deduplication, Analytics, IndexedDB Restart Survival, and Web Crypto AES-256-GCM).
 */
export async function runInBrowserVerificationSuite(): Promise<InAppTestCaseResult[]> {
  const results: InAppTestCaseResult[] = [];

  const runCase = async (
    id: string,
    suite: string,
    name: string,
    fn: () => Promise<string> | string
  ) => {
    const t0 = performance.now();
    try {
      const detail = await fn();
      results.push({
        id,
        suite,
        name,
        passed: true,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        assertionDetail: detail,
      });
    } catch (err: unknown) {
      results.push({
        id,
        suite,
        name,
        passed: false,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        assertionDetail: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await runCase(
    'san-1',
    'Sanitization & Privacy',
    'Strips dates, amounts, and currencies -> wildcard (*)',
    () => {
      const out = sanitizeTransactionDescription('REWE MARKT 14.50 EUR 12.03');
      if (out !== 'REWE MARKT *') {
        throw new Error(`Expected "REWE MARKT *", got "${out}"`);
      }
      return `"REWE MARKT 14.50 EUR 12.03" -> "${out}"`;
    }
  );

  await runCase(
    'san-2',
    'Sanitization & Privacy',
    'Strips IBANs, SEPA EREF/MREF tags, and personal names',
    () => {
      const audit = sanitizeTransactionAudit(
        'SEPA-ELV DE89370400440532013000 EREF+9928172 HERR MAX MUSTERMANN 12.03.2026 -45,90 EUR'
      );
      if (audit.sanitized.includes('DE89') || audit.sanitized.includes('MUSTERMANN')) {
        throw new Error(`Leaked sensitive token in: ${audit.sanitized}`);
      }
      return `Stripped ${audit.strippedTokens.length} sensitive tokens -> "${audit.sanitized}"`;
    }
  );

  await runCase(
    'csv-1',
    'CSV Engine & Encodings',
    'Decodes Windows-1252 / Latin-1 bank CSVs & German/Intl numbers',
    () => {
      const win1252Bytes = new Uint8Array([
        0x42, 0x65, 0x67, 0xfc, 0x6e, 0x73, 0x74, 0x69, 0x67, 0x74, 0x65, 0x72,
      ]);
      const decoded = decodeCsvBuffer(win1252Bytes.buffer, 'AUTO');
      const deNum = parseFlexibleAmount('1.234,56', 'AUTO');
      const intlNum = parseFlexibleAmount('-1,234.56', 'AUTO');
      const deDate = parseFlexibleDate('14.03.2026', 'AUTO');
      if (decoded.text !== 'Begünstigter' || deNum !== 1234.56 || intlNum !== -1234.56 || deDate !== '2026-03-14') {
        throw new Error('Encoding or locale number/date parsing mismatch');
      }
      return `Detected ${decoded.detectedEncoding} ("${decoded.text}"), DE 1.234,56 -> ${deNum}, Date -> ${deDate}`;
    }
  );

  await runCase(
    'csv-2',
    'CSV Engine & Encodings',
    'Detects duplicate imports while preserving same-day repeat purchases',
    () => {
      const csv = [
        'Buchungstag;Verwendungszweck;Betrag;Waehrung',
        '12.03.2026;REWE MARKT 14.50 EUR 12.03;-14,50;EUR',
        '12.03.2026;REWE MARKT 14.50 EUR 12.03;-14,50;EUR',
      ].join('\n');
      const mapping = inferColumnMapping(['Buchungstag', 'Verwendungszweck', 'Betrag', 'Waehrung']);
      const fingerprints = new Set<string>();
      const dummyAccount = {
        id: 'acc_verify',
        name: 'Verify',
        institution: 'DKB',
        accountType: 'Checking' as const,
        currency: 'EUR' as const,
        openingBalance: 0,
        createdAt: '2026-01-01',
      };
      const run1 = processCsvImport(csv, mapping, dummyAccount, fingerprints, new Map(), DEFAULT_EXCHANGE_RATES);
      const run2 = processCsvImport(csv, mapping, dummyAccount, fingerprints, new Map(), DEFAULT_EXCHANGE_RATES);
      if (run1.importedRecords.length !== 2 || run2.duplicateCount !== 2) {
        throw new Error('Duplicate detection failed');
      }
      return `Run 1 imported ${run1.importedRecords.length} same-day items; Run 2 blocked ${run2.duplicateCount} duplicates`;
    }
  );

  await runCase(
    'llm-1',
    'Deduplication & Cache',
    'Deduplicates unknown merchant strings before LLM batching',
    () => {
      const list = ['REWE MARKT *', 'REWE MARKT *', 'CAFE KREUZBERG *', 'CAFE KREUZBERG *'];
      const cache = new Map([
        [
          'REWE MARKT *',
          {
            sanitizedPattern: 'REWE MARKT *',
            category: 'Groceries' as const,
            costStructure: 'Variable' as const,
            necessity: 'Essential' as const,
            cadence: 'Recurring' as const,
            source: 'llm' as const,
            matchCount: 5,
            updatedAt: '2026-01-01',
          },
        ],
      ]);
      const unknown = getUnknownUniqueSanitizedMerchants(list, cache);
      if (unknown.length !== 1 || unknown[0] !== 'CAFE KREUZBERG *') {
        throw new Error('Deduplication failed');
      }
      return `4 raw rows -> 1 cached ("REWE MARKT *"), 1 unique unknown ("CAFE KREUZBERG *")`;
    }
  );

  await runCase(
    'ana-1',
    'Analytics & Moving Average',
    'Excludes internal transfers from expenses, nets refunds, and computes SMA trend',
    () => {
      const ma = computeMovingAverage([100, 200, 300, 600], 3);
      const txs = [
        {
          id: 't1',
          fingerprint: computeTransactionFingerprint('a', '2026-10-01', -200, 'SHOP'),
          accountId: 'a',
          bookingDate: '2026-10-01',
          amount: -200,
          currency: 'EUR' as const,
          amountInBaseCurrency: -200,
          rawDescription: 'SHOP',
          sanitizedMerchant: 'SHOP *',
          direction: 'expense' as const,
          category: 'Shopping & Retail' as const,
          costStructure: 'Variable' as const,
          necessity: 'Discretionary' as const,
          cadence: 'One-Off' as const,
          ruleSource: 'heuristic' as const,
          originalRawRow: {},
          importedAt: '2026-10-01',
        },
        {
          id: 't2',
          fingerprint: computeTransactionFingerprint('a', '2026-10-02', 50, 'REFUND'),
          accountId: 'a',
          bookingDate: '2026-10-02',
          amount: 50,
          currency: 'EUR' as const,
          amountInBaseCurrency: 50,
          rawDescription: 'REFUND',
          sanitizedMerchant: 'REFUND *',
          direction: 'refund' as const,
          category: 'Shopping & Retail' as const,
          costStructure: 'Variable' as const,
          necessity: 'Discretionary' as const,
          cadence: 'One-Off' as const,
          ruleSource: 'heuristic' as const,
          originalRawRow: {},
          importedAt: '2026-10-02',
        },
        {
          id: 't3',
          fingerprint: computeTransactionFingerprint('a', '2026-10-03', -500, 'TRANSFER'),
          accountId: 'a',
          bookingDate: '2026-10-03',
          amount: -500,
          currency: 'EUR' as const,
          amountInBaseCurrency: -500,
          rawDescription: 'TRANSFER',
          sanitizedMerchant: 'TRANSFER *',
          direction: 'transfer' as const,
          category: 'Internal Transfer' as const,
          costStructure: 'Fixed' as const,
          necessity: 'Essential' as const,
          cadence: 'Recurring' as const,
          ruleSource: 'heuristic' as const,
          originalRawRow: {},
          importedAt: '2026-10-03',
        },
      ];
      const summary = calculateFinancialAnalytics(txs, 'ALL', 3, 'ALL', '2026-10-05');
      if (summary.netExpenses !== 150 || summary.totalTransfers !== 500 || ma[3] !== 366.67) {
        throw new Error('Analytics calculation mismatch');
      }
      return `Gross 200€ - Refund 50€ = Net 150€ (500€ Transfer excluded); 3-period SMA = [${ma.join(', ')}]`;
    }
  );

  await runCase(
    'idb-1',
    'Data Safety & Persistence',
    'IndexedDB data survives simulated app restart & AES-256-GCM backup roundtrip',
    async () => {
      const ephemeralName = `verify_ephemeral_${Date.now()}`;
      const session1 = new BankingBuddyDB(ephemeralName);
      await ensureInitialSeedData(session1);
      const count1 = await session1.transactions.count();
      session1.close();

      // Reopen fresh instance simulating app restart
      const session2 = new BankingBuddyDB(ephemeralName);
      const count2 = await session2.transactions.count();
      await clearAllLocalData(session2);
      const countAfterClear = await session2.transactions.count();
      session2.close();
      await DexieDeleteHelper(ephemeralName);

      // Test AES-256-GCM encryption + decryption
      const enc = await createEncryptedBackup(
        { version: 2, exportedAt: new Date().toISOString(), accounts: [], transactions: [], rules: [] },
        'TestPassphrase#2026'
      );
      const dec = await decryptBackupEnvelope(enc, 'TestPassphrase#2026');

      if (count1 !== count2 || countAfterClear !== 0 || dec.version !== 2) {
        throw new Error('Persistence or encryption verification failed');
      }
      return `Persisted ${count2} records across DB restart, verified clearAllLocalData (0 remaining), & AES-256-GCM roundtrip`;
    }
  );

  return results;
}

async function DexieDeleteHelper(dbName: string): Promise<void> {
  return new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(dbName);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
