import {
  CadenceTag,
  CostStructureTag,
  MerchantRule,
  MultiDimensionalClassification,
  NecessityTag,
  TransactionCategory,
} from './types';

interface HeuristicPattern {
  keywords: RegExp;
  category: TransactionCategory;
  costStructure: CostStructureTag;
  necessity: NecessityTag;
  cadence: CadenceTag;
}

const HEURISTIC_RULES: HeuristicPattern[] = [
  {
    keywords: /\b(UMBUCHUNG|EIGENÜBERWEISUNG|EIGENUEBERWEISUNG|INTERNAL TRANSFER|SPARPLAN ÜBERTRAG|TAGESGELD)\b/i,
    category: 'Internal Transfer',
    costStructure: 'Variable',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(GEHALT|LOHN|SALARY|PAYROLL|BEZÜGE|BEZUEGE|DIVIDEND|GUTSCHRIFT ARBEITGEBER|FREELANCE HONORAR)\b/i,
    category: 'Salary & Income',
    costStructure: 'Fixed',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(REWE|EDEKA|ALDI|LIDL|NETTO|KAUFLAND|PENNY|ALNATURA|DENNS|BIO COMPANY|WHOLE FOODS|TRADER JOE|SUPERMARKT|CARREFOUR|TESCO|MIGROS|COOP)\b/i,
    category: 'Groceries',
    costStructure: 'Variable',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(MIETE|HAUSVERWALTUNG|WOHNUNGSBAU|STADTWERKE|VATTENFALL|E\.ON|ENBW|GASAG|STROM|HEIZUNG|RUNDFUNK|ARD ZDF|TELEKOM|VODAFONE|O2|1UND1|IMMOBILIEN)\b/i,
    category: 'Housing & Utilities',
    costStructure: 'Fixed',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(DB VERTRIEB|DEUTSCHE BAHN|BVG|MVG|HVV|DEUTSCHLANDTICKET|SHELL|ARAL|TOTAL|ESSO|JET TANKSTELLE|UBER|FREE NOW|BOLT|TIER|LIME|SIXT|ADAC|PARKEN)\b/i,
    category: 'Transport & Mobility',
    costStructure: 'Variable',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(LIEFERANDO|WOLT|UBER EATS|STARBUCKS|CAFE|BÄCKEREI|BAECKEREI|RESTAURANT|PIZZA|BURGER|SUSHI|BISTRO|BACKWERK|DEAN DAVID|VAPIANO|L OSTERIA)\b/i,
    category: 'Dining & Cafes',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
  },
  {
    keywords: /\b(APOTHEKE|DOCMORRIS|SHOP APOTHEKE|DM DROGERIE|ROSSMANN|MÜLLER DROGERIE|ZAHNARZT|PRAXIS|KRANKENHAUS|OPTIKER|FIELMANN|FITNESS|URBAN SPORTS|MCFIT)\b/i,
    category: 'Health & Pharmacy',
    costStructure: 'Variable',
    necessity: 'Essential',
    cadence: 'One-Off',
  },
  {
    keywords: /\b(SPOTIFY|NETFLIX|DISNEY|APPLE\.COM\/BILL|GOOGLE PLAY|YOUTUBE|PRIME VIDEO|DAZN|AUDIBLE|CHATGPT|GITHUB|NOTION|ICLOUD|NYTIMES|SPIEGEL)\b/i,
    category: 'Subscriptions & Media',
    costStructure: 'Fixed',
    necessity: 'Discretionary',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(ALLIANZ|HUK COBURG|TECHNIKER KRANKENKASSE|TK BEITRAG|AOK|BARMER|DAK|HAFTPFLICHT|VERSICHERUNG|FINANZAMT|STEUER|DEPOTGEBÜHR)\b/i,
    category: 'Insurance & Finance',
    costStructure: 'Fixed',
    necessity: 'Essential',
    cadence: 'Recurring',
  },
  {
    keywords: /\b(AMAZON|ZALANDO|IKEA|MEDIA MARKT|SATURN|OTTO|DECATHLON|H&M|UNIQLO|APPLE STORE|THALIA|HORNBACH|BAUHAUS|OBI)\b/i,
    category: 'Shopping & Retail',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
  },
  {
    keywords: /\b(LUFTHANSA|RYANAIR|EASYJET|BOOKING\.COM|AIRBNB|EXPEDIA|HOTEL|HOSTEL|FLIXX|FLIGHT)\b/i,
    category: 'Travel & Leisure',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
  },
];

/**
 * Offline deterministic merchant classifier.
 * Works 100% locally with zero network dependency.
 */
export function classifyMerchantSync(
  sanitizedMerchant: string,
  amount = -1
): MultiDimensionalClassification {
  for (const rule of HEURISTIC_RULES) {
    if (rule.keywords.test(sanitizedMerchant)) {
      return {
        category: rule.category,
        costStructure: rule.costStructure,
        necessity: rule.necessity,
        cadence: rule.cadence,
        ruleSource: 'heuristic',
        confidence: 0.9,
      };
    }
  }

  if (amount > 0) {
    return {
      category: 'Salary & Income',
      costStructure: 'Variable',
      necessity: 'Essential',
      cadence: 'One-Off',
      ruleSource: 'heuristic',
      confidence: 0.5,
    };
  }

  return {
    category: 'Other',
    costStructure: 'Variable',
    necessity: 'Discretionary',
    cadence: 'One-Off',
    ruleSource: 'heuristic',
    confidence: 0.3,
  };
}

/**
 * Extracts unique, deduplicated sanitized merchant strings from a list of transactions
 * that are not yet in the local rules cache (or are currently categorized as 'Other').
 */
export function getUnknownUniqueSanitizedMerchants(
  sanitizedMerchants: string[],
  cachedRules: Map<string, MerchantRule>
): string[] {
  const unique = new Set<string>();
  for (const raw of sanitizedMerchants) {
    const cleaned = raw.trim();
    if (!cleaned) continue;
    if (!cachedRules.has(cleaned)) {
      unique.add(cleaned);
    }
  }
  return Array.from(unique);
}

/**
 * Calls the server-side Gemini proxy (`/api/classify-merchants`) with ONLY deduplicated,
 * sanitized merchant strings and explicit user consent flag.
 */
export async function batchClassifyUniqueMerchantsWithLLM(
  sanitizedMerchants: string[],
  consentConfirmed: boolean
): Promise<MerchantRule[]> {
  if (!consentConfirmed) {
    throw new Error('Explicit user consent is required before running remote LLM merchant classification.');
  }

  const uniqueMerchants = Array.from(new Set(sanitizedMerchants.map((s) => s.trim()).filter(Boolean)));
  if (uniqueMerchants.length === 0) {
    return [];
  }

  const response = await fetch('/api/classify-merchants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sanitizedMerchants: uniqueMerchants,
      consentConfirmed: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.json().catch(() => ({}));
    throw new Error(errBody.error || `LLM classification failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    results: Array<{
      sanitizedPattern: string;
      category: TransactionCategory;
      costStructure: CostStructureTag;
      necessity: NecessityTag;
      cadence: CadenceTag;
    }>;
  };

  const now = new Date().toISOString();
  return (data.results || []).map((item) => ({
    sanitizedPattern: item.sanitizedPattern,
    category: item.category || 'Other',
    costStructure: item.costStructure === 'Fixed' ? 'Fixed' : 'Variable',
    necessity: item.necessity === 'Essential' ? 'Essential' : 'Discretionary',
    cadence: item.cadence === 'Recurring' ? 'Recurring' : 'One-Off',
    source: 'llm' as const,
    matchCount: 1,
    updatedAt: now,
  }));
}
