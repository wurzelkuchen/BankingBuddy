import React, { useState, useMemo, useEffect } from 'react';
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
import {
  ShieldCheck,
  Sparkles,
  Check,
  Code2,
  Trash2,
  Plus,
  RefreshCw,
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

interface CandidateItem {
  originalPattern: string;
  editablePattern: string;
  approved: boolean;
  occurrenceCount: number;
  sampleRawDescriptions: string[];
  strippedTokenSummary: string[];
  residualRiskLevel: 'Low' | 'Medium' | 'High';
  currentCategory: TransactionCategory;
  currentRuleSource: string;
}

interface LlmDebugAndApprovalViewProps {
  transactions: TransactionRecord[];
  rules: MerchantRule[];
  llmConsentGranted: boolean;
  onToggleLlmConsent: (granted: boolean) => Promise<void>;
  onSaveRulesAndApply: (newRules: MerchantRule[]) => Promise<void>;
  onDeleteRule: (sanitizedPattern: string) => Promise<void>;
}

export const LlmDebugAndApprovalView: React.FC<LlmDebugAndApprovalViewProps> = ({
  transactions,
  rules,
  llmConsentGranted,
  onToggleLlmConsent,
  onSaveRulesAndApply,
  onDeleteRule,
}) => {
  const [queueFilterMode, setQueueFilterMode] = useState<'UNCACHED_ONLY' | 'ALL_MERCHANTS'>(
    'UNCACHED_ONLY'
  );
  const [candidates, setCandidates] = useState<CandidateItem[]>([]);

  // Debug & Staged Response State
  const [isSending, setIsSending] = useState(false);
  const [lastRawResponseJson, setLastRawResponseJson] = useState<string | null>(null);
  const [stagedProposals, setStagedProposals] = useState<MerchantRule[]>([]);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Interactive Sanitization Live Sandbox
  const [sandboxInput, setSandboxInput] = useState(
    'SEPA-ELV DE89370400440532013000 EREF+9928172 REWE MARKT 14.50 EUR 12.03 HERR MAX MUSTERMANN'
  );
  const sandboxAudit = useMemo(
    () => sanitizeTransactionAudit(sandboxInput),
    [sandboxInput]
  );

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

  // Build deduplicated merchant groups from ledger transactions
  useEffect(() => {
    const grouped = new Map<
      string,
      {
        count: number;
        rawSamples: Set<string>;
        strippedTokens: Set<string>;
        risk: 'Low' | 'Medium' | 'High';
        category: TransactionCategory;
        ruleSource: string;
      }
    >();

    for (const tx of transactions) {
      const isCached = rulesMap.has(tx.sanitizedMerchant);
      if (queueFilterMode === 'UNCACHED_ONLY' && isCached && tx.category !== 'Other') {
        continue;
      }

      const existing = grouped.get(tx.sanitizedMerchant);
      const audit = sanitizeTransactionAudit(tx.rawDescription, tx.counterpartyRaw);

      if (!existing) {
        const rawSet = new Set<string>([tx.rawDescription]);
        const tokenSet = new Set<string>(
          audit.strippedTokens.map((t) => `${t.type}: "${t.value}"`)
        );
        grouped.set(tx.sanitizedMerchant, {
          count: 1,
          rawSamples: rawSet,
          strippedTokens: tokenSet,
          risk: audit.residualRiskLevel,
          category: tx.category,
          ruleSource: tx.ruleSource,
        });
      } else {
        existing.count += 1;
        if (existing.rawSamples.size < 3) {
          existing.rawSamples.add(tx.rawDescription);
        }
        audit.strippedTokens.forEach((t) => {
          if (existing.strippedTokens.size < 6) {
            existing.strippedTokens.add(`${t.type}: "${t.value}"`);
          }
        });
      }
    }

    const built: CandidateItem[] = Array.from(grouped.entries()).map(([pattern, info]) => ({
      originalPattern: pattern,
      editablePattern: pattern,
      approved: true,
      occurrenceCount: info.count,
      sampleRawDescriptions: Array.from(info.rawSamples),
      strippedTokenSummary: Array.from(info.strippedTokens),
      residualRiskLevel: info.risk,
      currentCategory: info.category,
      currentRuleSource: info.ruleSource,
    }));

    setCandidates(built);
  }, [transactions, rulesMap, queueFilterMode]);

  const approvedCandidates = useMemo(
    () => candidates.filter((c) => c.approved && c.editablePattern.trim().length > 0),
    [candidates]
  );

  // Exact outbound JSON body that will be sent to POST /api/classify-merchants
  const outboundPayloadPreview = useMemo(() => {
    const sanitizedMerchants = Array.from(
      new Set(approvedCandidates.map((c) => c.editablePattern.trim()))
    );
    return {
      endpoint: 'POST /api/classify-merchants',
      model: 'gemini-3.8-flash',
      privacyGuarantee: 'DEDUPLICATED_SANITIZED_LABELS_ONLY (Zero dates, amounts, IBANs, or raw rows)',
      requestBody: {
        consentConfirmed: llmConsentGranted,
        sanitizedMerchants,
      },
    };
  }, [approvedCandidates, llmConsentGranted]);

  const toggleCandidateApproval = (originalPattern: string) => {
    setCandidates((prev) =>
      prev.map((c) =>
        c.originalPattern === originalPattern ? { ...c, approved: !c.approved } : c
      )
    );
  };

  const updateCandidatePattern = (originalPattern: string, newText: string) => {
    setCandidates((prev) =>
      prev.map((c) =>
        c.originalPattern === originalPattern ? { ...c, editablePattern: newText } : c
      )
    );
  };

  const setAllCandidatesApproval = (approved: boolean) => {
    setCandidates((prev) => prev.map((c) => ({ ...c, approved })));
  };

  // Send approved payload to Gemini LLM and stage the AI results for inspection/approval
  const handleSendApprovedBatchToLLM = async () => {
    if (!llmConsentGranted) {
      setErrorBanner(
        'Approval required: Please check the explicit approval checkbox before transmitting the payload to the LLM.'
      );
      return;
    }
    const labels = outboundPayloadPreview.requestBody.sanitizedMerchants;
    if (labels.length === 0) {
      setErrorBanner('No approved merchant strings selected in the queue.');
      return;
    }

    setIsSending(true);
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const results = await batchClassifyUniqueMerchantsWithLLM(labels, true);
      setLastRawResponseJson(JSON.stringify(results, null, 2));
      setStagedProposals(results);
      setStatusBanner(
        `Received ${results.length} AI classifications from Gemini. Review or edit the proposed categories below, then click "Commit Approved AI Categories to Ledger".`
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'LLM request failed';
      setErrorBanner(msg);
    } finally {
      setIsSending(false);
    }
  };

  // Simulate / Stage with 100% Offline Heuristic Engine
  const handleStageOfflineHeuristics = () => {
    const labels = outboundPayloadPreview.requestBody.sanitizedMerchants;
    if (labels.length === 0) return;
    const now = new Date().toISOString();
    const generated: MerchantRule[] = labels.map((pattern) => {
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
    setLastRawResponseJson(JSON.stringify(generated, null, 2));
    setStagedProposals(generated);
    setErrorBanner(null);
    setStatusBanner(
      `Generated ${generated.length} classifications via local offline heuristics. Review or edit any category below before committing.`
    );
  };

  const handleUpdateStagedProposal = (
    sanitizedPattern: string,
    field: keyof Pick<MerchantRule, 'category' | 'costStructure' | 'necessity' | 'cadence'>,
    value: string
  ) => {
    setStagedProposals((prev) =>
      prev.map((item) =>
        item.sanitizedPattern === sanitizedPattern
          ? { ...item, [field]: value }
          : item
      )
    );
  };

  const handleCommitStagedProposals = async () => {
    if (stagedProposals.length === 0) return;
    await onSaveRulesAndApply(stagedProposals);
    setStatusBanner(
      `Committed ${stagedProposals.length} approved merchant rules to IndexedDB and updated all matching ledger rows.`
    );
    setStagedProposals([]);
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
      <div className="pb-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            LLM Outbound Debug Inspector & Categorization Approval Gate
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Inspect every stripped token, approve or edit individual sanitized merchant labels, verify the exact outbound JSON payload, and review AI categories before saving
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setQueueFilterMode('UNCACHED_ONLY')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              queueFilterMode === 'UNCACHED_ONLY'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Uncached / Unknown Only
          </button>
          <button
            type="button"
            onClick={() => setQueueFilterMode('ALL_MERCHANTS')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              queueFilterMode === 'ALL_MERCHANTS'
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Show All Unique Merchants ({rules.length} Cached)
          </button>
        </div>
      </div>

      {statusBanner && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 flex items-center justify-between">
          <span>{statusBanner}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-emerald-700 underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorBanner && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900 flex items-center justify-between">
          <span>
            {errorBanner} — You can also click &ldquo;Stage Offline Heuristic Classification&rdquo; to test the approval workflow without network calls.
          </span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="text-amber-800 underline ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step 1 & Step 2: Per-Merchant Approval Queue + Live Outbound JSON Payload Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 7 Columns: Per-Item Sanitization Trace & Approval Queue */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                1. Candidate Merchant Approval Queue ({approvedCandidates.length} of {candidates.length} Approved)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Uncheck any merchant you do not want sent, or edit its sanitized label inline before approving
              </p>
            </div>

            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => setAllCandidatesApproval(true)}
                className="text-slate-600 hover:text-slate-900 underline"
              >
                Approve All
              </button>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={() => setAllCandidatesApproval(false)}
                className="text-slate-600 hover:text-slate-900 underline"
              >
                Deselect All
              </button>
            </div>
          </div>

          {candidates.length === 0 ? (
            <div className="p-8 bg-slate-50 border border-slate-200 rounded-lg text-center space-y-2">
              <div className="text-sm font-medium text-slate-800">
                No Uncached Merchants Pending Approval
              </div>
              <p className="text-xs text-slate-500">
                All merchants in your ledger already have a rule in your Local Rules Cache. Switch to <strong>Show All Unique Merchants</strong> above if you want to inspect or re-classify existing merchants.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                    <th className="py-2.5 px-3 font-medium">Approve</th>
                    <th className="py-2.5 px-3 font-medium">Editable Sanitized Label (Sent to LLM)</th>
                    <th className="py-2.5 px-3 font-medium">Stripped Local PII (Never Sent)</th>
                    <th className="py-2.5 px-3 font-medium text-right">Rows</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {candidates.map((item) => (
                    <tr
                      key={item.originalPattern}
                      className={item.approved ? 'bg-white' : 'bg-slate-50/60 opacity-60'}
                    >
                      <td className="py-2.5 px-3 align-top">
                        <input
                          type="checkbox"
                          checked={item.approved}
                          onChange={() => toggleCandidateApproval(item.originalPattern)}
                          className="rounded border-slate-300 mt-1 cursor-pointer"
                        />
                      </td>
                      <td className="py-2.5 px-3 align-top space-y-1">
                        <input
                          type="text"
                          value={item.editablePattern}
                          onChange={(e) =>
                            updateCandidatePattern(item.originalPattern, e.target.value)
                          }
                          className="w-full px-2.5 py-1 font-mono font-semibold text-slate-900 bg-slate-50 border border-slate-300 rounded focus:bg-white focus:outline-none focus:border-slate-900"
                        />
                        <div className="text-[11px] text-slate-500">
                          Current: {item.currentCategory} ({item.currentRuleSource}) · Risk:{' '}
                          {item.residualRiskLevel}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 align-top max-w-xs">
                        <div className="text-[11px] text-slate-500 truncate">
                          Raw ex: {item.sampleRawDescriptions[0]}
                        </div>
                        <div className="font-mono text-[11px] text-rose-700 mt-0.5">
                          {item.strippedTokenSummary.length > 0
                            ? `Stripped: ${item.strippedTokenSummary.join(', ')}`
                            : 'No numeric/IBAN tokens present'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 align-top text-right font-mono tabular-nums font-medium text-slate-700">
                        {item.occurrenceCount}×
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Right 5 Columns: Live Outbound JSON Payload Inspector & Approval Gate */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                2. Exact Outbound LLM Request Inspector
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Live preview of the exact JSON payload queued for transmission
              </p>
            </div>
            <Code2 className="w-5 h-5 text-slate-700 shrink-0" />
          </div>

          <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg font-mono text-xs overflow-x-auto leading-relaxed max-h-72">
            {JSON.stringify(outboundPayloadPreview, null, 2)}
          </pre>

          <label className="flex items-start gap-2.5 text-xs text-slate-700 cursor-pointer pt-1">
            <input
              type="checkbox"
              checked={llmConsentGranted}
              onChange={(e) => onToggleLlmConsent(e.target.checked)}
              className="rounded border-slate-300 mt-0.5"
            />
            <span>
              <strong>Explicit Outbound Approval:</strong> I have inspected the JSON payload above and approve sending these{' '}
              <span className="font-mono font-semibold">
                {outboundPayloadPreview.requestBody.sanitizedMerchants.length}
              </span>{' '}
              deduplicated sanitized merchant strings for AI categorization.
            </span>
          </label>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 pt-2">
            <button
              type="button"
              disabled={
                isSending ||
                outboundPayloadPreview.requestBody.sanitizedMerchants.length === 0 ||
                !llmConsentGranted
              }
              onClick={handleSendApprovedBatchToLLM}
              className="flex-1 px-4 py-2.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-40 transition-colors flex items-center justify-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {isSending
                ? 'Transmitting Approved Batch...'
                : `Approve & Send (${outboundPayloadPreview.requestBody.sanitizedMerchants.length}) to Gemini LLM`}
            </button>

            <button
              type="button"
              disabled={outboundPayloadPreview.requestBody.sanitizedMerchants.length === 0}
              onClick={handleStageOfflineHeuristics}
              className="px-3.5 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Stage Offline Heuristics
            </button>
          </div>
        </div>
      </div>

      {/* Step 3: Staged AI Category Proposals & Raw Response Inspector (Review & Edit Before Saving) */}
      {(stagedProposals.length > 0 || lastRawResponseJson) && (
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                3. Review & Edit Staged AI Category Proposals ({stagedProposals.length})
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Inspect or override any AI-assigned category or multi-dimensional tag below before committing to your ledger & Local Rules Cache
              </p>
            </div>

            {stagedProposals.length > 0 && (
              <button
                type="button"
                onClick={handleCommitStagedProposals}
                className="px-4 py-2 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800 transition-colors flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                Commit {stagedProposals.length} Approved Categories to Ledger & Cache
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {stagedProposals.length > 0 && (
              <div className="lg:col-span-8 overflow-x-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                      <th className="py-2.5 px-3 font-medium">Sanitized Pattern</th>
                      <th className="py-2.5 px-3 font-medium">Proposed Category (Editable)</th>
                      <th className="py-2.5 px-3 font-medium">Cost Structure</th>
                      <th className="py-2.5 px-3 font-medium">Necessity</th>
                      <th className="py-2.5 px-3 font-medium">Cadence</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {stagedProposals.map((prop) => (
                      <tr key={prop.sanitizedPattern}>
                        <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                          {prop.sanitizedPattern}
                        </td>
                        <td className="py-2 px-3">
                          <select
                            value={prop.category}
                            onChange={(e) =>
                              handleUpdateStagedProposal(
                                prop.sanitizedPattern,
                                'category',
                                e.target.value
                              )
                            }
                            className="px-2 py-1 border border-slate-300 rounded bg-white font-medium text-slate-900"
                          >
                            {ALL_CATEGORIES.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="py-2 px-3">
                          <select
                            value={prop.costStructure}
                            onChange={(e) =>
                              handleUpdateStagedProposal(
                                prop.sanitizedPattern,
                                'costStructure',
                                e.target.value
                              )
                            }
                            className="px-2 py-1 border border-slate-300 rounded bg-white"
                          >
                            <option value="Variable">Variable</option>
                            <option value="Fixed">Fixed</option>
                          </select>
                        </td>
                        <td className="py-2 px-3">
                          <select
                            value={prop.necessity}
                            onChange={(e) =>
                              handleUpdateStagedProposal(
                                prop.sanitizedPattern,
                                'necessity',
                                e.target.value
                              )
                            }
                            className="px-2 py-1 border border-slate-300 rounded bg-white"
                          >
                            <option value="Essential">Essential</option>
                            <option value="Discretionary">Discretionary</option>
                          </select>
                        </td>
                        <td className="py-2 px-3">
                          <select
                            value={prop.cadence}
                            onChange={(e) =>
                              handleUpdateStagedProposal(
                                prop.sanitizedPattern,
                                'cadence',
                                e.target.value
                              )
                            }
                            className="px-2 py-1 border border-slate-300 rounded bg-white"
                          >
                            <option value="Recurring">Recurring</option>
                            <option value="One-Off">One-Off</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {lastRawResponseJson && (
              <div className={stagedProposals.length > 0 ? 'lg:col-span-4' : 'lg:col-span-12'}>
                <div className="text-xs font-medium text-slate-600 mb-1.5">
                  Raw Classifier Response JSON:
                </div>
                <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-lg font-mono text-[11px] overflow-x-auto max-h-64">
                  {lastRawResponseJson}
                </pre>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Step 4: Interactive Regex Sanitization Testbench & Local Rules Cache */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Single-String Sanitization Testbench
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Type any raw bank string to verify regex PII stripping
              </p>
            </div>
            <ShieldCheck className="w-5 h-5 text-emerald-700 shrink-0" />
          </div>

          <input
            type="text"
            value={sandboxInput}
            onChange={(e) => setSandboxInput(e.target.value)}
            className="w-full px-3 py-2 text-xs font-mono border border-slate-300 rounded-lg"
          />

          <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
            <div>
              <span className="text-slate-500">Sanitized Result: </span>
              <span className="font-mono font-semibold text-slate-900">
                {sandboxAudit.sanitized}
              </span>
            </div>
            <div className="font-mono text-[11px] text-slate-600">
              {sandboxAudit.strippedTokens.map((t, i) => (
                <div key={i}>
                  {t.type}: <span className="line-through text-rose-700">{t.value}</span> → *
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Local Rules Cache Manager */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Local Rules Cache ({rules.length} Active Rules)
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Cached rules categorize known merchants in 0ms on future imports without hitting any API
            </p>
          </div>

          <form
            onSubmit={handleCreateManualRule}
            className="grid grid-cols-1 sm:grid-cols-4 gap-2 p-3 bg-slate-50 border border-slate-200 rounded-lg items-end"
          >
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Pattern
              </label>
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g. ALNATURA BIO *"
                className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-700 mb-1">
                Category
              </label>
              <select
                value={newCategory}
                onChange={(e) => setNewCategory(e.target.value as TransactionCategory)}
                className="w-full px-2 py-1.5 text-xs bg-white border border-slate-300 rounded"
              >
                {ALL_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded hover:bg-slate-800 transition-colors flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Rule
            </button>
          </form>

          <div className="overflow-x-auto max-h-64 border border-slate-200 rounded-lg">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500">
                  <th className="py-2 px-3 font-medium">Sanitized Pattern</th>
                  <th className="py-2 px-3 font-medium">Category</th>
                  <th className="py-2 px-3 font-medium">Tags</th>
                  <th className="py-2 px-3 font-medium">Source</th>
                  <th className="py-2 px-3 text-right">Delete</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rules.map((r) => (
                  <tr key={r.sanitizedPattern} className="hover:bg-slate-50/80">
                    <td className="py-2 px-3 font-mono font-semibold text-slate-900">
                      {r.sanitizedPattern}
                    </td>
                    <td className="py-2 px-3 text-slate-800">{r.category}</td>
                    <td className="py-2 px-3 text-slate-500">
                      {r.costStructure} · {r.necessity} · {r.cadence}
                    </td>
                    <td className="py-2 px-3 font-mono text-slate-500">{r.source}</td>
                    <td className="py-2 px-3 text-right">
                      <button
                        type="button"
                        onClick={() => onDeleteRule(r.sanitizedPattern)}
                        className="text-slate-400 hover:text-rose-600 p-1"
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
    </div>
  );
};
