import Dexie, { type Table } from 'dexie';
import {
  AppSettings,
  BankAccount,
  MerchantRule,
  SupportedCurrency,
  TransactionRecord,
} from './types';
import { sanitizeTransactionDescription } from './sanitizer';
import { computeTransactionFingerprint } from './csvEngine';

export const DEFAULT_EXCHANGE_RATES: Record<SupportedCurrency, number> = {
  EUR: 1.0,
  USD: 0.92,
  GBP: 1.17,
  CHF: 1.04,
};

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'default',
  baseCurrency: 'EUR',
  exchangeRatesToEur: DEFAULT_EXCHANGE_RATES,
  llmConsentGranted: false,
  movingAverageWindow: 3,
  schemaVersion: 2,
};

export class BankingBuddyDB extends Dexie {
  accounts!: Table<BankAccount, string>;
  transactions!: Table<TransactionRecord, string>;
  rules!: Table<MerchantRule, string>;
  settings!: Table<AppSettings, string>;

  constructor(dbName = 'bankingBuddyLocalDB') {
    super(dbName);

    // Schema Version 1: Initial tables
    this.version(1).stores({
      accounts: 'id, name, currency',
      transactions: 'id, &fingerprint, accountId, bookingDate, sanitizedMerchant, category, direction',
      rules: 'sanitizedPattern, category, source',
      settings: 'id',
    });

    // Schema Version 2: Migration ensuring multi-currency normalization, direction flags, and audit row preservation
    this.version(2)
      .stores({
        accounts: 'id, name, currency, accountType',
        transactions:
          'id, &fingerprint, accountId, bookingDate, sanitizedMerchant, category, direction, costStructure, necessity, cadence',
        rules: 'sanitizedPattern, category, source, updatedAt',
        settings: 'id',
      })
      .upgrade(async (tx) => {
        await tx
          .table('transactions')
          .toCollection()
          .modify((record: Partial<TransactionRecord>) => {
            if (!record.currency) record.currency = 'EUR';
            if (typeof record.amountInBaseCurrency !== 'number') {
              record.amountInBaseCurrency = record.amount || 0;
            }
            if (!record.direction) {
              record.direction = (record.amount || 0) >= 0 ? 'income' : 'expense';
            }
            if (!record.originalRawRow) {
              record.originalRawRow = { migratedFromV1: 'true' };
            }
          });
      });
  }
}

export const db = new BankingBuddyDB();

/**
 * Seeds realistic multi-account European/German financial dataset if the database is empty.
 */
export async function ensureInitialSeedData(
  targetDb: BankingBuddyDB = db,
  forceReseed = false
): Promise<void> {
  const existingSettings = await targetDb.settings.get('default');
  if (!existingSettings) {
    await targetDb.settings.put({ ...DEFAULT_SETTINGS, initialSeedCompleted: true });
  } else if (existingSettings.initialSeedCompleted && !forceReseed) {
    return;
  } else {
    await targetDb.settings.put({ ...existingSettings, initialSeedCompleted: true });
  }

  const accountCount = await targetDb.accounts.count();
  if (accountCount > 0 && !forceReseed) return;

  const checkingAccount: BankAccount = {
    id: 'acc_dkb_giro',
    name: 'DKB Girokonto Primary',
    institution: 'DKB Deutsche Kreditbank',
    accountType: 'Checking',
    currency: 'EUR',
    ibanLast4: '3000',
    openingBalance: 4250.0,
    createdAt: '2026-05-01T08:00:00.000Z',
  };

  const creditAccount: BankAccount = {
    id: 'acc_n26_travel',
    name: 'N26 Smart Card (Multi-Currency)',
    institution: 'N26 Bank',
    accountType: 'Credit Card',
    currency: 'EUR',
    ibanLast4: '8821',
    openingBalance: 1200.0,
    createdAt: '2026-05-01T08:00:00.000Z',
  };

  await targetDb.accounts.bulkPut([checkingAccount, creditAccount]);

  const initialRules: MerchantRule[] = [
    {
      sanitizedPattern: 'REWE MARKT *',
      category: 'Groceries',
      costStructure: 'Variable',
      necessity: 'Essential',
      cadence: 'Recurring',
      source: 'llm',
      matchCount: 14,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      sanitizedPattern: 'HAUSVERWALTUNG BERLIN MIETE *',
      category: 'Housing & Utilities',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      source: 'manual',
      matchCount: 6,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      sanitizedPattern: 'SIEMENS AG GEHALT *',
      category: 'Salary & Income',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      source: 'manual',
      matchCount: 6,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      sanitizedPattern: 'STADTWERKE STROM ABSCHLAG *',
      category: 'Housing & Utilities',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      source: 'llm',
      matchCount: 6,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      sanitizedPattern: 'DEUTSCHE BAHN DB TICKET *',
      category: 'Transport & Mobility',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      source: 'llm',
      matchCount: 6,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
    {
      sanitizedPattern: 'SPOTIFY AB *',
      category: 'Subscriptions & Media',
      costStructure: 'Fixed',
      necessity: 'Discretionary',
      cadence: 'Recurring',
      source: 'llm',
      matchCount: 6,
      updatedAt: '2026-09-01T10:00:00.000Z',
    },
  ];

  await targetDb.rules.bulkPut(initialRules);

  // Create 6 months of realistic transactions (May 2026 - October 2026)
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'];
  const seedTxs: TransactionRecord[] = [];

  months.forEach((yyyyMm, mIdx) => {
    // 1. Monthly Salary
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-01`,
      amount: 3850.0,
      currency: 'EUR',
      rawDescription: `SIEMENS AG GEHALT ${yyyyMm} PNR 482910 DE89370400440532013000`,
      category: 'Salary & Income',
      direction: 'income',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      ruleSource: 'cache',
    });

    // 2. Monthly Rent
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-03`,
      amount: -1180.0,
      currency: 'EUR',
      rawDescription: `HAUSVERWALTUNG BERLIN MIETE ${yyyyMm} MREF+99281`,
      category: 'Housing & Utilities',
      direction: 'expense',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      ruleSource: 'manual',
    });

    // 3. Utilities
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-05`,
      amount: -94.5,
      currency: 'EUR',
      rawDescription: `STADTWERKE STROM ABSCHLAG KD 772819 94,50 EUR`,
      category: 'Housing & Utilities',
      direction: 'expense',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      ruleSource: 'cache',
    });

    // 4. Deutschlandticket Mobility
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-06`,
      amount: -49.0,
      currency: 'EUR',
      rawDescription: `DEUTSCHE BAHN DB TICKET 49.00 EUR ${yyyyMm}`,
      category: 'Transport & Mobility',
      direction: 'expense',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      ruleSource: 'cache',
    });

    // 5. Groceries (multiple per month with slight variation)
    const groceryAmounts = [-84.2, -112.45, -76.9, -98.3 - mIdx * 4.5];
    const groceryDays = ['08', '14', '20', '26'];
    groceryAmounts.forEach((amt, gIdx) => {
      addSeedTx(seedTxs, {
        accountId: 'acc_dkb_giro',
        bookingDate: `${yyyyMm}-${groceryDays[gIdx]}`,
        amount: Math.round(amt * 100) / 100,
        currency: 'EUR',
        rawDescription: `REWE MARKT ${Math.abs(amt).toFixed(2)} EUR ${groceryDays[gIdx]}.${yyyyMm.slice(5)}`,
        category: 'Groceries',
        direction: 'expense',
        costStructure: 'Variable',
        necessity: 'Essential',
        cadence: 'Recurring',
        ruleSource: 'cache',
      });
    });

    // 6. Health Insurance / Gym
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-10`,
      amount: -59.0,
      currency: 'EUR',
      rawDescription: `URBAN SPORTS CLUB GMBH ${yyyyMm} MITGLIEDSCHAFT`,
      category: 'Health & Pharmacy',
      direction: 'expense',
      costStructure: 'Fixed',
      necessity: 'Discretionary',
      cadence: 'Recurring',
      ruleSource: 'heuristic',
    });

    // 7. Subscriptions
    addSeedTx(seedTxs, {
      accountId: 'acc_n26_travel',
      bookingDate: `${yyyyMm}-12`,
      amount: -14.99,
      currency: 'EUR',
      rawDescription: `SPOTIFY AB 14.99 EUR STOCKHOLM ${yyyyMm}`,
      category: 'Subscriptions & Media',
      direction: 'expense',
      costStructure: 'Fixed',
      necessity: 'Discretionary',
      cadence: 'Recurring',
      ruleSource: 'cache',
    });

    // 8. Dining & Cafes
    addSeedTx(seedTxs, {
      accountId: 'acc_n26_travel',
      bookingDate: `${yyyyMm}-16`,
      amount: -(42.5 + mIdx * 6.0),
      currency: 'EUR',
      rawDescription: `L OSTERIA BERLIN KARTENZAHLUNG 16.${yyyyMm.slice(5)}.2026`,
      category: 'Dining & Cafes',
      direction: 'expense',
      costStructure: 'Variable',
      necessity: 'Discretionary',
      cadence: 'One-Off',
      ruleSource: 'heuristic',
    });

    // 9. Shopping & Retail + Occasional Refund
    addSeedTx(seedTxs, {
      accountId: 'acc_n26_travel',
      bookingDate: `${yyyyMm}-19`,
      amount: -(129.9 + (mIdx % 3) * 45),
      currency: 'EUR',
      rawDescription: `ZALANDO SE BESTELLUNG 994821${mIdx} 19.${yyyyMm.slice(5)}.2026`,
      category: 'Shopping & Retail',
      direction: 'expense',
      costStructure: 'Variable',
      necessity: 'Discretionary',
      cadence: 'One-Off',
      ruleSource: 'heuristic',
    });

    if (mIdx % 2 === 1) {
      addSeedTx(seedTxs, {
        accountId: 'acc_n26_travel',
        bookingDate: `${yyyyMm}-23`,
        amount: 64.95,
        currency: 'EUR',
        rawDescription: `ZALANDO SE GUTSCHRIFT RETOURE 994821${mIdx}`,
        category: 'Shopping & Retail',
        direction: 'refund',
        costStructure: 'Variable',
        necessity: 'Discretionary',
        cadence: 'One-Off',
        ruleSource: 'heuristic',
      });
    }

    // 10. Internal Transfer to Savings (excluded from expense totals!)
    addSeedTx(seedTxs, {
      accountId: 'acc_dkb_giro',
      bookingDate: `${yyyyMm}-25`,
      amount: -500.0,
      currency: 'EUR',
      rawDescription: `UMBUCHUNG TAGESGELD SPARPLAN DE89370400440532013000`,
      category: 'Internal Transfer',
      direction: 'transfer',
      costStructure: 'Fixed',
      necessity: 'Essential',
      cadence: 'Recurring',
      ruleSource: 'heuristic',
    });
  });

  // Add 3 unclassified / local boutique merchants in October 2026 so the user can test 1-click LLM Batch Classification!
  addSeedTx(seedTxs, {
    accountId: 'acc_n26_travel',
    bookingDate: '2026-10-18',
    amount: -34.8,
    currency: 'EUR',
    rawDescription: 'ROESTEREI KREUZBERG KAFFEEBOHNEN 34,80 EUR 18.10.2026',
    category: 'Other',
    direction: 'expense',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
    ruleSource: 'heuristic',
  });

  addSeedTx(seedTxs, {
    accountId: 'acc_n26_travel',
    bookingDate: '2026-10-21',
    amount: -78.0,
    currency: 'EUR',
    rawDescription: 'BOULDERKLUB BERLIN TICKET 78.00 EUR 21.10',
    category: 'Other',
    direction: 'expense',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
    ruleSource: 'heuristic',
  });

  addSeedTx(seedTxs, {
    accountId: 'acc_dkb_giro',
    bookingDate: '2026-10-22',
    amount: -29.9,
    currency: 'EUR',
    rawDescription: 'HETZNER ONLINE GMBH CLOUD SERVER RG 882192 22.10.2026',
    category: 'Other',
    direction: 'expense',
    costStructure: 'Fixed',
    necessity: 'Discretionary',
    cadence: 'Recurring',
    ruleSource: 'heuristic',
  });

  await targetDb.transactions.bulkPut(seedTxs);
}

function addSeedTx(
  list: TransactionRecord[],
  params: {
    accountId: string;
    bookingDate: string;
    amount: number;
    currency: SupportedCurrency;
    rawDescription: string;
    category: TransactionRecord['category'];
    direction: TransactionRecord['direction'];
    costStructure: TransactionRecord['costStructure'];
    necessity: TransactionRecord['necessity'];
    cadence: TransactionRecord['cadence'];
    ruleSource: TransactionRecord['ruleSource'];
  }
) {
  const sanitizedMerchant = sanitizeTransactionDescription(params.rawDescription);
  const fingerprint = computeTransactionFingerprint(
    params.accountId,
    params.bookingDate,
    params.amount,
    params.rawDescription,
    list.length
  );

  list.push({
    id: `seed_${list.length + 1}_${params.bookingDate}`,
    fingerprint,
    accountId: params.accountId,
    bookingDate: params.bookingDate,
    amount: params.amount,
    currency: params.currency,
    amountInBaseCurrency: params.amount,
    rawDescription: params.rawDescription,
    sanitizedMerchant,
    direction: params.direction,
    category: params.category,
    costStructure: params.costStructure,
    necessity: params.necessity,
    cadence: params.cadence,
    ruleSource: params.ruleSource,
    originalRawRow: {
      Buchungstag: params.bookingDate,
      Verwendungszweck: params.rawDescription,
      Betrag: params.amount.toFixed(2).replace('.', ','),
      Waehrung: params.currency,
    },
    importedAt: '2026-10-24T12:00:00.000Z',
  });
}

/**
 * Completely wipes all local IndexedDB tables (Transactions, Rules, Accounts, Settings)
 * and marks initialSeedCompleted: true so sample data is not re-seeded on page refresh.
 */
export async function clearAllLocalData(targetDb: BankingBuddyDB = db): Promise<void> {
  await targetDb.transaction(
    'rw',
    targetDb.accounts,
    targetDb.transactions,
    targetDb.rules,
    targetDb.settings,
    async () => {
      await targetDb.transactions.clear();
      await targetDb.rules.clear();
      await targetDb.accounts.clear();
      await targetDb.settings.clear();
      await targetDb.settings.put({ ...DEFAULT_SETTINGS, initialSeedCompleted: true });
    }
  );
}

/**
 * Clears all transaction rows while preserving existing bank accounts and merchant rules
 * (or creating one clean default account if none exist) so the user can immediately import their own CSV.
 */
export async function clearTransactionsOnly(targetDb: BankingBuddyDB = db): Promise<void> {
  await targetDb.transaction(
    'rw',
    targetDb.accounts,
    targetDb.transactions,
    targetDb.settings,
    async () => {
      await targetDb.transactions.clear();
      const count = await targetDb.accounts.count();
      if (count === 0) {
        await targetDb.accounts.put({
          id: 'acc_default_checking',
          name: 'Primary Checking',
          institution: 'Main Bank',
          accountType: 'Checking',
          currency: 'EUR',
          openingBalance: 0,
          createdAt: new Date().toISOString(),
        });
      }
      const existingSettings = await targetDb.settings.get('default');
      await targetDb.settings.put({
        ...(existingSettings || DEFAULT_SETTINGS),
        initialSeedCompleted: true,
      });
    }
  );
}

