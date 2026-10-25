import React, { useState, useMemo } from 'react';
import {
  CadenceTag,
  CostStructureTag,
  MerchantRule,
  NecessityTag,
  TransactionCategory,
  TransactionRecord,
} from '../lib/types';
import { sanitizeTransactionAudit } from '../lib/sanitizer';
import {
  batchClassifyUniqueMerchantsWithLLM,
  classifyMerchantSync,
} from '../lib/classifier';
import { ShieldCheck, Sparkles, Trash2, Plus } from 'lucide-react';

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

interface PrivacyAndRulesViewProps {
  transactions: TransactionRecord[];
  rules: MerchantRule[];
  llmConsentGranted: boolean;
  onToggleLlmConsent: (granted: boolean) => Promise<void>;
  onSaveRulesAndApply: (newRules: MerchantRule[]) => Promise<void>;
  onDeleteRule: (sanitizedPattern: string) => Promise<void>;
}

export const PrivacyAndRulesView: React.FC<PrivacyAndRulesViewProps> = ({
  transactions,
  rules,
  llmConsentGranted,
  onToggleLlmConsent,
  onSaveRulesAndApply,
  onDeleteRule,
}) => {
  // Interactive Sanitization Live Sandbox
  const [sandboxInput, setSandboxInput] = useState(
    'SEPA-ELV DE89370400440532013000 EREF+9928172 REWE MARKT 14.50 EUR 12.03 HERR MAX MUSTERMANN'
  );
  const sandboxAudit = useMemo(
    () => sanitizeTransactionAudit(sandboxInput),
    [sandboxInput]
  );

  // LLM Batching State
  const [isClassifying, setIsClassifying] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);

  // Manual Rule Creation State
  const [newPattern, setNewPattern] = useState('');
  const [newCategory, setNewCategory] = useState<TransactionCategory>('Groceries');
  const [newCost, setNewCost] = useState<CostStructureTag>('Variable');
  const [newNecessity, setNewNecessity] = useState<NecessityTag>('Essential');
  const [newCadence, setNewCadence] = useState<CadenceTag>('Recurring');

  const rulesMap = useMemo(
    () => new Map(rules.map((r) => [r.sanitizedPattern, r])),
    [rules]
  );

  // Deduplicated unknown / 'Other' sanitized merchant strings
  const unknownUniqueMerchants = useMemo(() => {
    const set = new Set<string>();
    for (const tx of transactions) {
      if (tx.category === 'Other' || !rulesMap.has(tx.sanitizedMerchant)) {
        if (!rulesMap.has(tx.sanitizedMerchant)) {
          set.add(tx.sanitizedMerchant);
        }
      }
    }
    return Array.from(set);
  }, [transactions, rulesMap]);

  const handleRunLlmBatch = async () => {
    if (!llmConsentGranted) {
      setBatchError('Please check the explicit consent box before sending sanitized merchant labels.');
      return;
    }
    if (unknownUniqueMerchants.length === 0) return;

    setIsClassifying(true);
    setBatchError(null);
    setBatchMessage(null);
    try {
      const classifiedRules = await batchClassifyUniqueMerchantsWithLLM(
        unknownUniqueMerchants,
        true
      );
      await onSaveRulesAndApply(classifiedRules);
      setBatchMessage(
        `Classified ${classifiedRules.length} unique sanitized merchant patterns via Gemini API and saved to Local Rules Cache.`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Batch classification failed';
      // Provide offline heuristic fallback option if API is unreachable
      setBatchError(msg);
    } finally {
      setIsClassifying(false);
    }
  };

  const handleRunOfflineHeuristicBatch = async () => {
    if (unknownUniqueMerchants.length === 0) return;
    const now = new Date().toISOString();
    const generated: MerchantRule[] = unknownUniqueMerchants.map((pattern) => {
      const c = classifyMerchantSync(pattern, -10);
      return {
        sanitizedPattern: pattern,
        category: c.category === 'Other' ? 'Shopping & Retail' : c.category,
        costStructure: c.costStructure,
        necessity: c.necessity,
        cadence: c.cadence,
        source: 'heuristic',
        matchCount: 1,
        updatedAt: now,
      };
    });
    await onSaveRulesAndApply(generated);
    setBatchMessage(
      `Classified ${generated.length} unique merchant patterns 100% offline and cached rules locally.`
    );
    setBatchError(null);
  };

  const handleCreateManualRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPattern.trim()) return;
    const sanitized = sanitizeTransactionAudit(newPattern).sanitized;
    const rule: MerchantRule = {
      sanitizedPattern: sanitized,
      category: newCategory,
      costStructure: newCost,
      necessity: newNecessity,
      cadence: newCadence,
      source: 'manual',
      matchCount: 1,
      updatedAt: new Date().toISOString(),
    };
    await onSaveRulesAndApply([rule]);
    setNewPattern('');
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="pb-5 border-b border-slate-200">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Privacy Sanitization, Consented LLM Pipeline & Local Rules Cache
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          Zero transaction-level telemetry · Only deduplicated, wildcard-sanitized merchant labels ever leave the device when explicitly consented
        </p>
      </div>

      {/* Section 1: Interactive Sanitization Live Sandbox & Residual Risk Audit */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Interactive Sanitization Sandbox
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Test how raw bank booking descriptions are stripped of IBANs, dates, amounts, SEPA refs, and names
              </p>
            </div>
            <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0" />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Raw Bank Transaction String
            </label>
            <input
              type="text"
              value={sandboxInput}
              onChange={(e) => setSandboxInput(e.target.value)}
              className="w-full px-3.5 py-2.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:border-slate-900"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-xs text-slate-500">Sanitized Output (Wildcard Pattern):</div>
              <div className="text-sm font-mono font-semibold text-slate-900 mt-1.5 break-all">
                {sandboxAudit.sanitized}
              </div>
            </div>

            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg">
              <div className="text-xs text-slate-500">
                Stripped Sensitive Tokens ({sandboxAudit.strippedTokens.length}):
              </div>
              <div className="text-xs font-mono text-slate-700 mt-1.5 space-y-1">
                {sandboxAudit.strippedTokens.length === 0 ? (
                  <span className="text-slate-400">No PII/numeric tokens detected</span>
                ) : (
                  sandboxAudit.strippedTokens.map((t, idx) => (
                    <div key={idx}>
                      {t.type}: <span className="line-through text-rose-700">{t.value}</span> → *
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => setSandboxInput('REWE MARKT 14.50 EUR 12.03')}
              className="px-2.5 py-1 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md font-mono"
            >
              Sample: REWE MARKT 14.50 EUR 12.03
            </button>
            <button
              type="button"
              onClick={() =>
                setSandboxInput(
                  'ÜBERWEISUNG AN PRAXIS DR MED MÜLLER DE89370400440532013000 185,40 EUR 19.10.2026'
                )
              }
              className="px-2.5 py-1 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-md font-mono"
            >
              Sample: Medical / IBAN / Name
            </button>
          </div>
        </div>

        {/* Residual Re-Identification Risk Disclosure */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4">
          <div className="space-y-3">
            <h2 className="text-base font-semibold text-slate-900">
              Residual Re-Identification Risk Model
            </h2>
            <p className="text-xs text-slate-600 leading-relaxed">
              While regex sanitization deterministically removes exact transaction dates, amounts, IBANs, SEPA mandate IDs, card numbers, and personal salutations, <strong>merchant names alone can still carry residual contextual risk</strong>:
            </p>
            <ul className="text-xs text-slate-600 space-y-2 list-disc pl-4">
              <li>
                <strong>Geographic Narrowing:</strong> Regional merchants (e.g., <span className="font-mono">STADTWERKE MÜNCHEN *</span> or a neighborhood bakery) reveal the city or district you frequent.
              </li>
              <li>
                <strong>Employer or Landlord Names:</strong> Unique company or property management strings can correlate with employment or residence.
              </li>
              <li>
                <strong>Sensitive Establishments:</strong> Medical practices (<span className="font-mono">PRAXIS *</span>, <span className="font-mono">APOTHEKE *</span>) or religious/political organizations may reveal sensitive personal attributes even without amounts or dates.
              </li>
            </ul>
          </div>

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-700">
            <div>
              Current Sandbox Residual Risk:{' '}
              <strong
                className={
                  sandboxAudit.residualRiskLevel === 'Low'
                    ? 'text-emerald-700'
                    : 'text-amber-700'
                }
              >
                {sandboxAudit.residualRiskLevel}
              </strong>
            </div>
            {sandboxAudit.residualRiskNotes.length > 0 ? (
              <div className="mt-1 text-slate-500">{sandboxAudit.residualRiskNotes.join(' ')}</div>
            ) : (
              <div className="mt-1 text-slate-500">
                High-anonymity national merchant pattern with no local/medical markers.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Section 2: Unique-String LLM Batch Classification Pipeline */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Unique-String Deduplicated Batch Classification Pipeline
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Identical recurring merchants are deduplicated so each unknown sanitized label is classified only once and permanently cached locally
            </p>
          </div>
          <div className="text-xs font-mono text-slate-600">
            Uncached Unique Patterns: <strong>{unknownUniqueMerchants.length}</strong>
          </div>
        </div>

        <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
          <div className="text-xs font-medium text-slate-700">
            Exact Payload Preview (Only these {unknownUniqueMerchants.length} deduplicated strings are eligible for classification):
          </div>
          {unknownUniqueMerchants.length === 0 ? (
            <div className="text-xs text-emerald-700 font-mono">
              All sanitized merchant strings in your ledger are already cached in your Local Rules Cache.
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {unknownUniqueMerchants.map((m) => (
                <span
                  key={m}
                  className="font-mono text-xs text-slate-800 bg-white border border-slate-200 px-2.5 py-1 rounded-md"
                >
                  {m}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-4 pt-2">
          <label className="flex items-center gap-2.5 text-xs text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              checked={llmConsentGranted}
              onChange={(e) => onToggleLlmConsent(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span>
              I explicitly consent to sending only the deduplicated, sanitized merchant labels shown above to the server-side Gemini classification endpoint
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={unknownUniqueMerchants.length === 0}
              onClick={handleRunOfflineHeuristicBatch}
              className="px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
            >
              Classify Offline (Local Heuristics)
            </button>
            <button
              type="button"
              disabled={isClassifying || unknownUniqueMerchants.length === 0 || !llmConsentGranted}
              onClick={handleRunLlmBatch}
              className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isClassifying
                ? 'Classifying Unique Labels...'
                : `Batch Classify ${unknownUniqueMerchants.length} Labels via Gemini`}
            </button>
          </div>
        </div>

        {batchMessage && (
          <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            {batchMessage}
          </div>
        )}
        {batchError && (
          <div className="text-xs text-amber-900 bg-amber-50 border border-amber-200 rounded-lg p-3">
            {batchError} — You can click &ldquo;Classify Offline (Local Heuristics)&rdquo; to categorize all {unknownUniqueMerchants.length} merchants locally with zero network dependency.
          </div>
        )}
      </div>

      {/* Section 3: Local Rules Cache Table & Manual Rule Creator */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Local Rules Cache ({rules.length} Cached Merchant Rules)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Stored in IndexedDB · Known merchants auto-categorize in 0ms on future CSV imports without hitting any API
            </p>
          </div>
        </div>

        {/* Add Custom Rule Form */}
        <form
          onSubmit={handleCreateManualRule}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-lg items-end"
        >
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Merchant Pattern (Sanitized)
            </label>
            <input
              type="text"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              placeholder="e.g. ALNATURA BIO MARKT *"
              className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Category</label>
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as TransactionCategory)}
              className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
            >
              {ALL_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Cost / Necessity</label>
            <div className="flex gap-1">
              <select
                value={newCost}
                onChange={(e) => setNewCost(e.target.value as CostStructureTag)}
                className="w-1/2 px-2 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
              >
                <option value="Variable">Variable</option>
                <option value="Fixed">Fixed</option>
              </select>
              <select
                value={newNecessity}
                onChange={(e) => setNewNecessity(e.target.value as NecessityTag)}
                className="w-1/2 px-2 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
              >
                <option value="Essential">Essential</option>
                <option value="Discretionary">Discretionary</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Cadence</label>
            <select
              value={newCadence}
              onChange={(e) => setNewCadence(e.target.value as CadenceTag)}
              className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
            >
              <option value="Recurring">Recurring</option>
              <option value="One-Off">One-Off</option>
            </select>
          </div>

          <div>
            <button
              type="submit"
              className="w-full px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Rule
            </button>
          </div>
        </form>

        {/* Cached Rules Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500">
                <th className="py-2.5 px-3 font-medium">Sanitized Merchant Pattern</th>
                <th className="py-2.5 px-3 font-medium">Category</th>
                <th className="py-2.5 px-3 font-medium">Multi-Dimensional Tags</th>
                <th className="py-2.5 px-3 font-medium">Origin</th>
                <th className="py-2.5 px-3 font-medium text-right">Remove</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {rules.map((rule) => (
                <tr key={rule.sanitizedPattern} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">
                    {rule.sanitizedPattern}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-slate-800">{rule.category}</td>
                  <td className="py-2.5 px-3 text-slate-600">
                    <span>{rule.costStructure}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{rule.necessity}</span>
                    <span aria-hidden="true"> · </span>
                    <span>{rule.cadence}</span>
                  </td>
                  <td className="py-2.5 px-3 font-mono text-slate-500">{rule.source}</td>
                  <td className="py-2.5 px-3 text-right">
                    <button
                      type="button"
                      onClick={() => onDeleteRule(rule.sanitizedPattern)}
                      className="text-slate-400 hover:text-rose-600 transition-colors p-1"
                      title="Delete Rule"
                    >
                      <Trash2 className="w-3.5 h-3.5 inline" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
