import React, { useState, useEffect } from 'react';
import { ARCHITECTURE_FILES } from '../lib/architectureScaffolding';
import {
  InAppTestCaseResult,
  runInBrowserVerificationSuite,
} from '../lib/inAppTestSuite';
import { Play, CheckCircle2, XCircle, Copy, Check } from 'lucide-react';

export const ArchitectureAndTestsView: React.FC = () => {
  const [testResults, setTestResults] = useState<InAppTestCaseResult[]>([]);
  const [isRunningTests, setIsRunningTests] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState(ARCHITECTURE_FILES[0].path);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const executeTests = async () => {
    setIsRunningTests(true);
    try {
      const results = await runInBrowserVerificationSuite();
      setTestResults(results);
    } finally {
      setIsRunningTests(false);
    }
  };

  useEffect(() => {
    executeTests();
  }, []);

  const selectedFile =
    ARCHITECTURE_FILES.find((f) => f.path === selectedFilePath) || ARCHITECTURE_FILES[0];

  const handleCopyCode = (path: string, code: string) => {
    navigator.clipboard?.writeText(code);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  const passedCount = testResults.filter((r) => r.passed).length;

  return (
    <div className="space-y-8">
      <div className="pb-5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Android WebView Container, CI/CD Matrix & Verification Suite
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Complete project scaffolding on disk (`web/`, `app/`, `.github/workflows/ci-cd.yml`) and live in-browser test verification
          </p>
        </div>

        <button
          type="button"
          disabled={isRunningTests}
          onClick={executeTests}
          className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Play className="w-3.5 h-3.5" />
          {isRunningTests ? 'Running Verification Suite...' : 'Re-Run Verification Suite'}
        </button>
      </div>

      {/* Live In-Browser Verification Suite Results */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Automated Unit & Integration Verification Suite
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Tests regex sanitization, Windows-1252 & German CSV parsing, duplicate fingerprinting, moving averages, IndexedDB restart survival, and AES-256-GCM encryption
            </p>
          </div>
          <div className="text-xs font-mono tabular-nums text-emerald-700 font-semibold">
            {passedCount} / {testResults.length} Assertions Passing
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2.5 px-3 font-medium">Status</th>
                <th className="py-2.5 px-3 font-medium">Suite</th>
                <th className="py-2.5 px-3 font-medium">Test Specification</th>
                <th className="py-2.5 px-3 font-medium">Verified Output</th>
                <th className="py-2.5 px-3 font-medium text-right">Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {testResults.map((res) => (
                <tr key={res.id} className="hover:bg-slate-50/80">
                  <td className="py-2.5 px-3 whitespace-nowrap">
                    {res.passed ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        PASS
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-rose-700 font-medium">
                        <XCircle className="w-3.5 h-3.5" />
                        FAIL
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-medium text-slate-700 whitespace-nowrap">
                    {res.suite}
                  </td>
                  <td className="py-2.5 px-3 text-slate-900 font-medium">{res.name}</td>
                  <td className="py-2.5 px-3 font-mono text-slate-600">{res.assertionDetail}</td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-500">
                    {res.durationMs.toFixed(1)} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Android & CI/CD File Inspector */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-4 space-y-2">
          <div className="text-xs font-semibold text-slate-900 px-2 py-1">
            Repository Scaffolding Files
          </div>
          {ARCHITECTURE_FILES.map((file) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setSelectedFilePath(file.path)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-colors ${
                selectedFile.path === file.path
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <div className="text-xs font-mono font-medium truncate">{file.path}</div>
              <div
                className={`text-[11px] mt-0.5 truncate ${
                  selectedFile.path === file.path ? 'text-slate-300' : 'text-slate-500'
                }`}
              >
                {file.title} · {file.category}
              </div>
            </button>
          ))}
        </div>

        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-100 pb-4">
            <div>
              <div className="text-xs font-mono text-slate-500">{selectedFile.path}</div>
              <h3 className="text-base font-semibold text-slate-900 mt-0.5">
                {selectedFile.title}
              </h3>
              <p className="text-xs text-slate-600 mt-1">{selectedFile.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => handleCopyCode(selectedFile.path, selectedFile.code)}
              className="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors inline-flex items-center gap-1.5 shrink-0"
            >
              {copiedPath === selectedFile.path ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-700" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  Copy Source
                </>
              )}
            </button>
          </div>

          <ul className="text-xs text-slate-600 space-y-1 list-disc pl-4">
            {selectedFile.highlights.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ul>

          <pre className="p-4 bg-slate-900 text-slate-100 rounded-lg font-mono text-xs overflow-x-auto leading-relaxed">
            {selectedFile.code}
          </pre>
        </div>
      </div>
    </div>
  );
};
