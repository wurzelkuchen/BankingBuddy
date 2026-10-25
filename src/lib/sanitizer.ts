import { SanitizationResult } from './types';

/**
 * Deterministic Privacy Sanitization Engine
 *
 * Strips exact dates, currency amounts, IBANs, BICs, SEPA references, card masks,
 * postal/store numbers, and direct personal identifiers from transaction descriptions,
 * replacing contiguous stripped tokens with a single wildcard `*`.
 *
 * Example:
 *   "REWE MARKT 14.50 EUR 12.03" -> "REWE MARKT *"
 *   "SEPA-ELV DE89370400440532013000 EREF+9928172 REWE SAGT DANKE 12.03.2026 45,90 EUR" -> "SEPA-ELV * REWE SAGT DANKE *"
 */
export function sanitizeTransactionAudit(
  rawDescription: string,
  counterpartyRaw?: string
): SanitizationResult {
  const combinedSource = [counterpartyRaw, rawDescription]
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .join(' ');

  if (!combinedSource) {
    return {
      original: '',
      sanitized: 'UNKNOWN MERCHANT *',
      strippedTokens: [],
      residualRiskLevel: 'Low',
      residualRiskNotes: [],
    };
  }

  let working = combinedSource;
  const strippedTokens: SanitizationResult['strippedTokens'] = [];

  // 1. Strip IBANs (standard compact or spaced European/International IBANs)
  const ibanPattern = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/gi;
  working = working.replace(ibanPattern, (match) => {
    strippedTokens.push({ type: 'IBAN', value: match.trim() });
    return ' * ';
  });

  // 2. Strip SEPA structured tags (EREF+, MREF+, KREF+, CRED+, SVWZ+, ABWA+, IBAN+, BIC+)
  const sepaTagPattern = /\b(?:EREF|MREF|KREF|CRED|DEBT|SVWZ|ABWA|IBAN|BIC|MANDAT|REF)\+[A-Z0-9\-/.:_]+\b/gi;
  working = working.replace(sepaTagPattern, (match) => {
    strippedTokens.push({ type: 'SEPA_REF', value: match });
    return ' * ';
  });

  // 3. Strip masked or full card / account numbers (e.g. XXXX-1234, ****1234, NR. 12345678)
  const cardPattern = /\b(?:[*X]{4,12}[-\s]?\d{4}|KARTEN[-\s]?NR\.?\s*\d+|NR\.?\s*\d{4,})\b/gi;
  working = working.replace(cardPattern, (match) => {
    strippedTokens.push({ type: 'CARD_NUMBER', value: match });
    return ' * ';
  });

  // 4. Strip explicit currency amounts (e.g. 14.50 EUR, 1.234,56 €, EUR 49,99, -23,40 USD, $19.99)
  const amountWithCurrencyPattern =
    /(?:[-+]?\s?\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\s?(?:EUR|USD|GBP|CHF|€|\$|£))|(?:(?:EUR|USD|GBP|CHF|€|\$|£)\s?[-+]?\d{1,3}(?:[.,]\d{3})*[.,]\d{2})/gi;
  working = working.replace(amountWithCurrencyPattern, (match) => {
    strippedTokens.push({ type: 'AMOUNT', value: match.trim() });
    return ' * ';
  });

  // 5. Strip dates: DD.MM.YYYY, DD.MM.YY, DD.MM., YYYY-MM-DD, MM/DD/YYYY, DD/MM/YYYY, timestamps HH:MM(:SS)
  const datePattern =
    /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{2}\.\d{2}\.?|\d{2}:\d{2}(?::\d{2})?)\b/g;
  working = working.replace(datePattern, (match) => {
    strippedTokens.push({ type: 'DATE', value: match.trim() });
    return ' * ';
  });

  // 6. Strip remaining standalone decimal numbers (e.g., 14.50, 129,90)
  const standaloneDecimalPattern = /\b[-+]?\d+[.,]\d{2}\b/g;
  working = working.replace(standaloneDecimalPattern, (match) => {
    strippedTokens.push({ type: 'AMOUNT', value: match.trim() });
    return ' * ';
  });

  // 7. Strip email addresses, phone numbers, or personal salutations / names (Herr/Frau/Mr/Ms + Name)
  const personalIdPattern =
    /\b(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:HERR|FRAU|MR\.?|MRS\.?|MS\.?|DR\.?)\s+[A-ZÄÖÜß]+(?:\s+[A-ZÄÖÜß]+)?)\b/gi;
  working = working.replace(personalIdPattern, (match) => {
    strippedTokens.push({ type: 'PERSONAL_ID', value: match.trim() });
    return ' * ';
  });

  // 8. Strip any remaining numeric sequences or store/branch/invoice IDs (2+ digits, or alphanumeric tokens with 3+ digits)
  const numberSeqPattern = /\b(?:[A-Z0-9]*\d{2,}[A-Z0-9]*|\d+)\b/gi;
  working = working.replace(numberSeqPattern, (match) => {
    strippedTokens.push({ type: 'NUMBER_SEQ', value: match.trim() });
    return ' * ';
  });

  // 9. Strip leftover standalone currency codes if adjacent to wildcards
  working = working.replace(/\b(?:EUR|USD|GBP|CHF)\b/gi, ' * ');

  // Normalize casing, punctuation, and collapse multiple adjacent wildcards `* *` -> `*`
  let normalized = working
    .toUpperCase()
    .replace(/[,;:/\\|()[\]{}"'`~+#=_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Collapse repeated `*` separated by spaces or hyphens into a single `*`
  normalized = normalized.replace(/(?:\*\s*[-]*\s*)+/g, '* ').trim();
  normalized = normalized.replace(/\s+\*/g, ' *').replace(/\*\s+/g, '* ');

  if (!normalized || normalized === '*') {
    normalized = 'UNKNOWN MERCHANT *';
  }

  // Evaluate residual re-identification risk
  const residualRiskNotes: string[] = [];
  let residualRiskLevel: 'Low' | 'Medium' | 'High' = 'Low';

  const cleanWords = normalized
    .replace(/\*/g, '')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  const cityOrLocalHints = ['APOTHEKE', 'PRAXIS', 'DR', 'KITA', 'SCHULE', 'VEREIN', 'GEMEINDE', 'STADT', 'FINANZAMT', 'MIETE', 'VERMIETER'];
  if (cleanWords.some((w) => cityOrLocalHints.includes(w))) {
    residualRiskLevel = 'Medium';
    residualRiskNotes.push(
      'Merchant label contains a municipal, medical, or landlord keyword that could narrow geographic or personal context.'
    );
  }

  if (cleanWords.length >= 5) {
    if (residualRiskLevel === 'Low') residualRiskLevel = 'Medium';
    residualRiskNotes.push(
      'Long multi-word merchant label may contain a distinctive local business or employer name.'
    );
  }

  return {
    original: combinedSource,
    sanitized: normalized,
    strippedTokens,
    residualRiskLevel,
    residualRiskNotes,
  };
}

/**
 * Convenience string-only wrapper returning the sanitized merchant pattern.
 * Example: sanitizeTransactionDescription("REWE MARKT 14.50 EUR 12.03") === "REWE MARKT *"
 */
export function sanitizeTransactionDescription(rawDescription: string, counterpartyRaw?: string): string {
  return sanitizeTransactionAudit(rawDescription, counterpartyRaw).sanitized;
}
