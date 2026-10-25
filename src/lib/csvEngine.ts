import Papa from 'papaparse';
import {
  BankAccount,
  CsvColumnMapping,
  SupportedCurrency,
  TransactionDirection,
  TransactionRecord,
} from './types';
import { sanitizeTransactionDescription } from './sanitizer';
import { classifyMerchantSync } from './classifier';

/**
 * Decodes an ArrayBuffer from a CSV file upload, automatically detecting UTF-8 vs Windows-1252 / ISO-8859-1
 * (common in German Sparkasse, Volksbank, DKB, and Commerzbank CSV exports).
 */
export function decodeCsvBuffer(
  buffer: ArrayBuffer,
  preferredEncoding: 'AUTO' | 'UTF-8' | 'WINDOWS-1252' = 'AUTO'
): { text: string; detectedEncoding: 'UTF-8' | 'WINDOWS-1252' } {
  const uint8 = new Uint8Array(buffer);

  if (preferredEncoding === 'UTF-8') {
    return {
      text: new TextDecoder('utf-8').decode(uint8),
      detectedEncoding: 'UTF-8',
    };
  }

  if (preferredEncoding === 'WINDOWS-1252') {
    return {
      text: new TextDecoder('windows-1252').decode(uint8),
      detectedEncoding: 'WINDOWS-1252',
    };
  }

  // AUTO: Try strict UTF-8 first; if invalid byte sequences exist (e.g. German umlauts ä/ö/ü/ß in Latin1/Windows-1252), fall back
  try {
    const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
    const decoded = strictUtf8.decode(uint8);
    return { text: decoded, detectedEncoding: 'UTF-8' };
  } catch {
    const winDecoder = new TextDecoder('windows-1252');
    return { text: winDecoder.decode(uint8), detectedEncoding: 'WINDOWS-1252' };
  }
}

/**
 * Parses German ("1.234,56", "-45,90 EUR", "120,00-") and International ("1,234.56", "-45.90") numbers.
 */
export function parseFlexibleAmount(
  rawVal: string | number | undefined | null,
  format: 'AUTO' | 'DE_COMMA' | 'INTL_DOT' = 'AUTO'
): number {
  if (typeof rawVal === 'number') {
    return Number.isFinite(rawVal) ? rawVal : 0;
  }
  if (!rawVal) return 0;

  let cleaned = String(rawVal).trim();
  if (!cleaned) return 0;

  // Handle trailing minus sign used by some German bank exports (e.g. "45,90-")
  let isNegative = false;
  if (cleaned.endsWith('-')) {
    isNegative = true;
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.startsWith('-') || (cleaned.includes('(') && cleaned.includes(')'))) {
    isNegative = true;
  }

  // Strip currency symbols and spaces
  cleaned = cleaned.replace(/[^\d.,]/g, '');
  if (!cleaned) return 0;

  let normalizedNumberStr = cleaned;

  if (format === 'DE_COMMA') {
    normalizedNumberStr = cleaned.replace(/\./g, '').replace(',', '.');
  } else if (format === 'INTL_DOT') {
    normalizedNumberStr = cleaned.replace(/,/g, '');
  } else {
    // AUTO detection based on last separator position
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');

    if (lastComma > lastDot) {
      // Comma is the decimal separator (German/European format: 1.234,56 or 45,90)
      normalizedNumberStr = cleaned.replace(/\./g, '').replace(',', '.');
    } else if (lastDot > lastComma) {
      // Dot is the decimal separator (International format: 1,234.56 or 45.90)
      const partsAfterDot = cleaned.slice(lastDot + 1);
      if (lastComma === -1 && partsAfterDot.length === 3 && cleaned.indexOf('.') === lastDot) {
        normalizedNumberStr = cleaned.replace(/\./g, '');
      } else {
        normalizedNumberStr = cleaned.replace(/,/g, '');
      }
    } else {
      normalizedNumberStr = cleaned;
    }
  }

  const parsed = parseFloat(normalizedNumberStr);
  if (!Number.isFinite(parsed)) return 0;
  return isNegative ? -Math.abs(parsed) : parsed;
}

/**
 * Parses German (DD.MM.YYYY, DD.MM.YY), ISO (YYYY-MM-DD), and US (MM/DD/YYYY) dates into ISO YYYY-MM-DD.
 */
export function parseFlexibleDate(
  rawDate: string | undefined | null,
  format: 'AUTO' | 'DD.MM.YYYY' | 'YYYY-MM-DD' | 'MM/DD/YYYY' = 'AUTO'
): string | null {
  if (!rawDate) return null;
  const trimmed = String(rawDate).trim();
  if (!trimmed) return null;

  // Check ISO YYYY-MM-DD (or YYYY/MM/DD)
  const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch;
    return formatIsoParts(Number(y), Number(m), Number(d));
  }

  // Check DD.MM.YYYY or DD.MM.YY (German standard)
  const deMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
  if (deMatch) {
    const [, d, m, yRaw] = deMatch;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    return formatIsoParts(year, Number(m), Number(d));
  }

  // Check slash-separated dates: MM/DD/YYYY or DD/MM/YYYY
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (slashMatch) {
    const [, first, second, yRaw] = slashMatch;
    const year = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
    const n1 = Number(first);
    const n2 = Number(second);

    if (format === 'MM/DD/YYYY' || (format === 'AUTO' && n1 <= 12 && n2 > 12)) {
      return formatIsoParts(year, n1, n2);
    }
    if (format === 'DD.MM.YYYY' || n1 > 12) {
      return formatIsoParts(year, n2, n1);
    }
    return formatIsoParts(year, n1, n2);
  }

  return null;
}

function formatIsoParts(year: number, month: number, day: number): string | null {
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Deterministic transaction fingerprint for duplicate detection across multiple imports.
 */
export function computeTransactionFingerprint(
  accountId: string,
  bookingDate: string,
  amount: number,
  rawDescription: string,
  occurrenceIndexInFile = 0
): string {
  const normalizedDesc = rawDescription.trim().toUpperCase().replace(/\s+/g, ' ');
  const amountCents = Math.round(amount * 100);
  const canonical = `${accountId}|${bookingDate}|${amountCents}|${normalizedDesc}|#${occurrenceIndexInFile}`;

  let h1 = 0xdeadbeef ^ canonical.length;
  let h2 = 0x41c6ce57 ^ canonical.length;
  for (let i = 0; i < canonical.length; i++) {
    const ch = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `txfp_${(h2 >>> 0).toString(16).padStart(8, '0')}${(h1 >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Extracts headers and sample preview rows from raw CSV text, supporting manual or auto header-line offset
 * (for bank exports that prepend metadata lines above the table header).
 */
export function extractCsvStructure(
  csvText: string,
  manualHeaderRowOffset?: number
): {
  headers: string[];
  sampleRows: Record<string, string>[];
  detectedHeaderRowOffset: number;
} {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let offset = typeof manualHeaderRowOffset === 'number' ? manualHeaderRowOffset : 0;

  if (typeof manualHeaderRowOffset !== 'number') {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      const lower = lines[i].toLowerCase();
      if (
        (lower.includes('datum') || lower.includes('buchung') || lower.includes('date')) &&
        (lower.includes('betrag') ||
          lower.includes('umsatz') ||
          lower.includes('amount') ||
          lower.includes('soll') ||
          lower.includes('debit'))
      ) {
        offset = i;
        break;
      }
    }
  }

  const slicedText = lines.slice(offset).join('\n');
  const parsed = Papa.parse<Record<string, string>>(slicedText, {
    header: true,
    preview: 5,
    skipEmptyLines: true,
  });

  return {
    headers: parsed.meta.fields || [],
    sampleRows: parsed.data.slice(0, 3),
    detectedHeaderRowOffset: offset,
  };
}

/**
 * Auto-detects column mapping from CSV headers (supports German & English bank exports,
 * including both single signed Amount columns and split Soll/Haben or Debit/Credit columns).
 */
export function inferColumnMapping(
  headers: string[],
  headerRowOffset = 0
): CsvColumnMapping {
  const findHeader = (candidates: string[]): string => {
    for (const c of candidates) {
      const exact = headers.find((h) => h.trim().toLowerCase() === c.toLowerCase());
      if (exact) return exact;
    }
    for (const c of candidates) {
      const partial = headers.find((h) => h.trim().toLowerCase().includes(c.toLowerCase()));
      if (partial) return partial;
    }
    return '';
  };

  const bookingDateCol =
    findHeader(['Buchungstag', 'Buchungsdatum', 'Valutadatum', 'Booking Date', 'Date', 'Datum']) ||
    headers[0] ||
    '';

  const counterpartyCol = findHeader([
    'Beguenstigter/Zahlungspflichtiger',
    'Begünstigter/Zahlungspflichtiger',
    'Auftraggeber/Empfänger',
    'Zahlungsempfänger',
    'Zahlungspflichtiger',
    'Payee',
    'Merchant',
    'Counterparty',
    'Empfänger',
    'Name',
  ]);

  const descriptionCol =
    findHeader([
      'Verwendungszweck',
      'Buchungstext',
      'Vorgang/Verwendungszweck',
      'Description',
      'Subject',
      'Reference',
      'Purpose',
      'Memo',
    ]) ||
    counterpartyCol ||
    headers[1] ||
    '';

  const debitCol = findHeader(['Soll', 'Ausgang', 'Lastschrift', 'Debit', 'Withdrawal', 'Belastung']);
  const creditCol = findHeader(['Haben', 'Eingang', 'Gutschrift', 'Credit', 'Deposit']);

  const singleAmountCol = findHeader([
    'Betrag',
    'Umsatz',
    'Amount',
    'Value',
    'Betrag (EUR)',
    'Betrag in EUR',
  ]);

  const useSplitMode = !singleAmountCol && Boolean(debitCol && creditCol);

  const amountCol = singleAmountCol || headers[headers.length - 1] || '';
  const currencyCol = findHeader(['Waehrung', 'Währung', 'Currency', 'Curr']);
  const typeCol = findHeader(['Buchungstext', 'Umsatzart', 'Type', 'Transaction Type']);

  return {
    bookingDateCol,
    descriptionCol,
    counterpartyCol: counterpartyCol || undefined,
    amountMode: useSplitMode ? 'SPLIT' : 'SINGLE',
    amountCol,
    debitCol: debitCol || undefined,
    creditCol: creditCol || undefined,
    currencyCol: currencyCol || undefined,
    typeCol: typeCol || undefined,
    headerRowOffset,
    dateFormat: 'AUTO',
    decimalFormat: 'AUTO',
    encoding: 'AUTO',
  };
}

/**
 * Determines transaction direction: 'income' | 'expense' | 'transfer' | 'refund'
 */
export function detectTransactionDirection(
  amount: number,
  sanitizedMerchant: string,
  rawDescription: string,
  explicitCategory?: string
): TransactionDirection {
  const upper = `${sanitizedMerchant} ${rawDescription}`.toUpperCase();

  // 1. Check if internal transfer
  if (
    explicitCategory === 'Internal Transfer' ||
    /\b(UMBUCHUNG|EIGENÜBERWEISUNG|EIGENUEBERWEISUNG|INTERNAL TRANSFER|SPARPLAN ÜBERTRAG|TAGESGELD ÜBERTRAG|OWN ACCOUNT)\b/.test(
      upper
    )
  ) {
    return 'transfer';
  }

  // 2. If positive amount, check if it's a refund/chargeback from a retail/expense merchant vs genuine income
  if (amount > 0) {
    const isRefundKeyword =
      /\b(ERSTATTUNG|RÜCKERSTATTUNG|RUECKERSTATTUNG|GUTSCHRIFT RETOURE|RETOURE|REFUND|CHARGEBACK|STORNO)\b/.test(
        upper
      );
    const isKnownRetailRefund =
      /\b(AMAZON|ZALANDO|PAYPAL|REWE|ALDI|LIDL|DM DROGERIE|IKE|APPLE|DB BAHN|DEUTSCHE BAHN|MEDIA MARKT)\b/.test(
        upper
      ) && !/\b(GEHALT|LOHN|SALARY|DIVIDEND)\b/.test(upper);

    if (isRefundKeyword || isKnownRetailRefund) {
      return 'refund';
    }
    return 'income';
  }

  return 'expense';
}

export interface CsvImportBatchResult {
  importedRecords: TransactionRecord[];
  duplicateCount: number;
  skippedInvalidRows: number;
  uniqueSanitizedMerchants: string[];
  unknownSanitizedMerchants: string[];
}

/**
 * Parses CSV text with PapaParse and processes rows through the Sanitization & Local Rules Engine.
 */
export function processCsvImport(
  csvText: string,
  mapping: CsvColumnMapping,
  account: BankAccount,
  existingFingerprints: Set<string>,
  knownRulesMap: Map<
    string,
    {
      category: TransactionRecord['category'];
      costStructure: TransactionRecord['costStructure'];
      necessity: TransactionRecord['necessity'];
      cadence: TransactionRecord['cadence'];
      source: 'manual' | 'llm' | 'heuristic';
    }
  >,
  exchangeRatesToEur: Record<SupportedCurrency, number>
): CsvImportBatchResult {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let headerLineIdx = typeof mapping.headerRowOffset === 'number' ? mapping.headerRowOffset : 0;

  if (typeof mapping.headerRowOffset !== 'number') {
    for (let i = 0; i < Math.min(lines.length, 15); i++) {
      if (lines[i].includes(mapping.bookingDateCol)) {
        headerLineIdx = i;
        break;
      }
    }
  }

  const cleanCsvText = lines.slice(headerLineIdx).join('\n');

  const parsed = Papa.parse<Record<string, string>>(cleanCsvText, {
    header: true,
    skipEmptyLines: true,
  });

  const importedRecords: TransactionRecord[] = [];
  let duplicateCount = 0;
  let skippedInvalidRows = 0;
  const uniqueMerchantsSet = new Set<string>();
  const unknownMerchantsSet = new Set<string>();
  const sameFileKeyCounter = new Map<string, number>();

  for (let i = 0; i < parsed.data.length; i++) {
    const row = parsed.data[i];
    const rawDate = row[mapping.bookingDateCol];
    const bookingDate = parseFlexibleDate(rawDate, mapping.dateFormat);
    if (!bookingDate) {
      skippedInvalidRows++;
      continue;
    }

    let amount = 0;
    if (mapping.amountMode === 'SPLIT' && (mapping.debitCol || mapping.creditCol)) {
      const rawDebit = mapping.debitCol ? row[mapping.debitCol] : '';
      const rawCredit = mapping.creditCol ? row[mapping.creditCol] : '';
      if (!rawDebit && !rawCredit) {
        skippedInvalidRows++;
        continue;
      }
      const debitVal = Math.abs(parseFlexibleAmount(rawDebit, mapping.decimalFormat));
      const creditVal = Math.abs(parseFlexibleAmount(rawCredit, mapping.decimalFormat));
      amount = Math.round((creditVal - debitVal) * 100) / 100;
    } else {
      const rawAmountStr = row[mapping.amountCol];
      amount = parseFlexibleAmount(rawAmountStr, mapping.decimalFormat);
      if (amount === 0 && !rawAmountStr) {
        skippedInvalidRows++;
        continue;
      }
    }

    const counterpartyRaw = mapping.counterpartyCol ? (row[mapping.counterpartyCol] || '').trim() : '';
    const descPart = (row[mapping.descriptionCol] || '').trim();
    const typePart = mapping.typeCol ? (row[mapping.typeCol] || '').trim() : '';

    const rawDescription = [counterpartyRaw, descPart, typePart]
      .filter(Boolean)
      .filter((val, idx, arr) => arr.indexOf(val) === idx)
      .join(' — ');

    if (!rawDescription) {
      skippedInvalidRows++;
      continue;
    }

    const baseOccurrenceKey = `${account.id}|${bookingDate}|${Math.round(amount * 100)}|${rawDescription.toUpperCase()}`;
    const occurrenceIdx = sameFileKeyCounter.get(baseOccurrenceKey) || 0;
    sameFileKeyCounter.set(baseOccurrenceKey, occurrenceIdx + 1);

    const fingerprint = computeTransactionFingerprint(
      account.id,
      bookingDate,
      amount,
      rawDescription,
      occurrenceIdx
    );

    if (existingFingerprints.has(fingerprint)) {
      duplicateCount++;
      continue;
    }

    const sanitizedMerchant = sanitizeTransactionDescription(
      descPart || rawDescription,
      counterpartyRaw
    );
    uniqueMerchantsSet.add(sanitizedMerchant);

    const cachedRule = knownRulesMap.get(sanitizedMerchant);
    const classification = cachedRule
      ? {
          category: cachedRule.category,
          costStructure: cachedRule.costStructure,
          necessity: cachedRule.necessity,
          cadence: cachedRule.cadence,
          ruleSource: cachedRule.source === 'manual' ? ('manual' as const) : ('cache' as const),
        }
      : classifyMerchantSync(sanitizedMerchant, amount);

    if (!cachedRule && classification.category === 'Other') {
      unknownMerchantsSet.add(sanitizedMerchant);
    }

    const rawCurr = mapping.currencyCol
      ? (row[mapping.currencyCol] || '').trim().toUpperCase()
      : account.currency;
    const currency: SupportedCurrency =
      rawCurr === 'USD' || rawCurr === 'GBP' || rawCurr === 'CHF' || rawCurr === 'EUR'
        ? rawCurr
        : account.currency;

    const rate = exchangeRatesToEur[currency] || 1;
    const amountInBaseCurrency = Math.round(amount * rate * 100) / 100;

    const direction = detectTransactionDirection(
      amount,
      sanitizedMerchant,
      rawDescription,
      classification.category
    );

    const finalCategory =
      direction === 'transfer' ? 'Internal Transfer' : classification.category;

    const record: TransactionRecord = {
      id: `tx_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      fingerprint,
      accountId: account.id,
      bookingDate,
      amount,
      currency,
      amountInBaseCurrency,
      rawDescription,
      counterpartyRaw: counterpartyRaw || undefined,
      sanitizedMerchant,
      direction,
      category: finalCategory,
      costStructure: classification.costStructure,
      necessity: classification.necessity,
      cadence: classification.cadence,
      ruleSource: classification.ruleSource,
      originalRawRow: { ...row },
      importedAt: new Date().toISOString(),
    };

    importedRecords.push(record);
    existingFingerprints.add(fingerprint);
  }

  return {
    importedRecords,
    duplicateCount,
    skippedInvalidRows,
    uniqueSanitizedMerchants: Array.from(uniqueMerchantsSet),
    unknownSanitizedMerchants: Array.from(unknownMerchantsSet),
  };
}
