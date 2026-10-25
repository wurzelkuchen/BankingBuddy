import React, { useState } from 'react';
import {
  AppSettings,
  BankAccount,
  EncryptedBackupEnvelope,
  MerchantRule,
  SupportedCurrency,
  TransactionRecord,
} from '../lib/types';
import {
  createEncryptedBackup,
  decryptBackupEnvelope,
  PlainBackupPayload,
} from '../lib/cryptoBackup';
import { Lock, Download, Upload, Trash2, Plus, RotateCcw } from 'lucide-react';

interface BackupAndStorageViewProps {
  accounts: BankAccount[];
  transactions: TransactionRecord[];
  rules: MerchantRule[];
  settings: AppSettings;
  onAddAccount: (account: BankAccount) => Promise<void>;
  onRestoreBackup: (payload: PlainBackupPayload) => Promise<void>;
  onClearAllData: () => Promise<void>;
  onReseedDemoData: () => Promise<void>;
}

export const BackupAndStorageView: React.FC<BackupAndStorageViewProps> = ({
  accounts,
  transactions,
  rules,
  settings,
  onAddAccount,
  onRestoreBackup,
  onClearAllData,
  onReseedDemoData,
}) => {
  // Encrypted Backup State
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [importPassphrase, setImportPassphrase] = useState('');
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // New Account Form
  const [accName, setAccName] = useState('');
  const [accInst, setAccInst] = useState('');
  const [accType, setAccType] = useState<BankAccount['accountType']>('Checking');
  const [accCurrency, setAccCurrency] = useState<SupportedCurrency>('EUR');
  const [accBalance, setAccBalance] = useState('1000');

  const handleExportEncrypted = async (e: React.FormEvent) => {
    e.preventDefault();
    setBackupError(null);
    setBackupStatus(null);
    try {
      const payload: PlainBackupPayload = {
        version: 2,
        exportedAt: new Date().toISOString(),
        accounts,
        transactions,
        rules,
        settings,
      };
      const envelope = await createEncryptedBackup(payload, exportPassphrase);
      const blob = new Blob([JSON.stringify(envelope, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bankingBuddy_backup_${new Date().toISOString().slice(0, 10)}.bbuddy.enc.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setBackupStatus(
        `Encrypted ${transactions.length} transactions and ${rules.length} rules using AES-256-GCM (PBKDF2 100,000 iterations).`
      );
    } catch (err: unknown) {
      setBackupError(err instanceof Error ? err.message : 'Encryption failed');
    }
  };

  const handleImportEncryptedFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBackupError(null);
    setBackupStatus(null);
    try {
      const rawText = await file.text();
      const envelope = JSON.parse(rawText) as EncryptedBackupEnvelope;
      const decrypted = await decryptBackupEnvelope(envelope, importPassphrase);
      await onRestoreBackup(decrypted);
      setBackupStatus(
        `Restored ${decrypted.transactions.length} transactions, ${decrypted.accounts.length} accounts, and ${decrypted.rules.length} rules into IndexedDB.`
      );
      setImportPassphrase('');
    } catch (err: unknown) {
      setBackupError(
        err instanceof Error ? err.message : 'Failed to decrypt or restore backup file.'
      );
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accName.trim()) return;
    const newAcc: BankAccount = {
      id: `acc_${Date.now()}`,
      name: accName.trim(),
      institution: accInst.trim() || 'Local Bank',
      accountType: accType,
      currency: accCurrency,
      openingBalance: parseFloat(accBalance) || 0,
      createdAt: new Date().toISOString(),
    };
    await onAddAccount(newAcc);
    setAccName('');
    setAccInst('');
  };

  return (
    <div className="space-y-8">
      <div className="pb-5 border-b border-slate-200">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          Encrypted Backups, Multi-Account Ledger & Storage Safety
        </h1>
        <p className="text-sm text-slate-600 mt-1">
          AES-256-GCM authenticated backups · Multi-currency account management · Browser vs. Android native storage boundaries
        </p>
      </div>

      {backupStatus && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900">
          {backupStatus}
        </div>
      )}
      {backupError && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900">
          {backupError}
        </div>
      )}

      {/* Encrypted Backup & Restore Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Export Encrypted Backup */}
        <form
          onSubmit={handleExportEncrypted}
          className="bg-white border border-slate-200 rounded-xl p-6 space-y-4"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Export Encrypted Backup (.bbuddy.enc.json)
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Derives a 256-bit key via PBKDF2-SHA256 (100k iterations) and encrypts with AES-256-GCM
              </p>
            </div>
            <Lock className="w-5 h-5 text-slate-700 shrink-0" />
          </div>

          <div className="text-xs text-slate-600 font-mono tabular-nums bg-slate-50 p-3 rounded-lg border border-slate-200">
            Snapshot scope: {accounts.length} Accounts · {transactions.length} Transactions ·{' '}
            {rules.length} Cached Merchant Rules · Schema v{settings.schemaVersion}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Encryption Passphrase (min 4 chars)
            </label>
            <input
              type="password"
              value={exportPassphrase}
              onChange={(e) => setExportPassphrase(e.target.value)}
              placeholder="Enter strong passphrase to encrypt snapshot..."
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              required
              minLength={4}
            />
          </div>

          <button
            type="submit"
            className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5"
          >
            <Download className="w-3.5 h-3.5" />
            Download Encrypted Backup
          </button>
        </form>

        {/* Restore Encrypted Backup */}
        <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Restore from Encrypted Backup
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Verifies AES-GCM authentication tag before replacing local IndexedDB tables
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Decryption Passphrase
            </label>
            <input
              type="password"
              value={importPassphrase}
              onChange={(e) => setImportPassphrase(e.target.value)}
              placeholder="Enter passphrase used during backup export..."
              className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
            />
          </div>

          <div className="pt-1">
            <label
              className={`px-4 py-2 text-xs font-medium rounded-lg inline-flex items-center gap-1.5 transition-colors ${
                importPassphrase.length >= 4
                  ? 'bg-slate-900 text-white hover:bg-slate-800 cursor-pointer'
                  : 'bg-slate-200 text-slate-500 cursor-not-allowed'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Select Encrypted Backup File
              <input
                type="file"
                accept=".json"
                disabled={importPassphrase.length < 4}
                onChange={handleImportEncryptedFile}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </div>

      {/* Multi-Account & Currency Configuration */}
      <div className="bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Configured Accounts & Currencies ({accounts.length})
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Supports EUR, USD, GBP, and CHF accounts with automatic normalization into your base currency ({settings.baseCurrency})
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {accounts.map((acc) => (
            <div key={acc.id} className="p-4 border border-slate-200 rounded-lg space-y-1">
              <div className="text-sm font-semibold text-slate-900">{acc.name}</div>
              <div className="text-xs text-slate-500">
                {acc.institution} · {acc.accountType} · {acc.currency}
              </div>
              <div className="text-xs font-mono tabular-nums text-slate-700 pt-1">
                Opening Balance: {acc.openingBalance.toFixed(2)} {acc.currency}
              </div>
            </div>
          ))}
        </div>

        <form
          onSubmit={handleCreateAccount}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-lg items-end"
        >
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Account Name</label>
            <input
              type="text"
              value={accName}
              onChange={(e) => setAccName(e.target.value)}
              placeholder="e.g. Wise USD Account"
              className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Institution</label>
            <input
              type="text"
              value={accInst}
              onChange={(e) => setAccInst(e.target.value)}
              placeholder="e.g. Wise / Revolut"
              className="w-full px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Type & Currency</label>
            <div className="flex gap-1">
              <select
                value={accType}
                onChange={(e) => setAccType(e.target.value as BankAccount['accountType'])}
                className="w-3/5 px-2 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
              >
                <option value="Checking">Checking</option>
                <option value="Savings">Savings</option>
                <option value="Credit Card">Credit Card</option>
                <option value="Cash">Cash</option>
              </select>
              <select
                value={accCurrency}
                onChange={(e) => setAccCurrency(e.target.value as SupportedCurrency)}
                className="w-2/5 px-2 py-1.5 text-xs bg-white border border-slate-300 rounded-lg font-mono"
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="CHF">CHF</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">Opening Balance</label>
            <input
              type="number"
              step="0.01"
              value={accBalance}
              onChange={(e) => setAccBalance(e.target.value)}
              className="w-full px-3 py-1.5 text-xs font-mono bg-white border border-slate-300 rounded-lg"
            />
          </div>
          <div>
            <button
              type="submit"
              className="w-full px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors flex items-center justify-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Account
            </button>
          </div>
        </form>
      </div>

      {/* Storage Architecture Documentation & Clear All Data */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-6 space-y-3">
          <h2 className="text-base font-semibold text-slate-900">
            Browser Storage Limitations vs. Android Native Secure Storage
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-slate-600 leading-relaxed pt-1">
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-900">
                1. Browser IndexedDB & Origin Sandbox
              </div>
              <p>
                All ledger records, raw CSV rows, and merchant rule caches reside in IndexedDB (<span className="font-mono">bankingBuddyLocalDB</span>, Schema v2). While isolated by Same-Origin Policy, browser storage is unencrypted at rest on the OS filesystem and can be evicted if the user clears site data or runs in private/incognito browsing mode. Export encrypted <span className="font-mono">.bbuddy.enc.json</span> backups regularly.
              </p>
            </div>
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-900">
                2. Android WebView & Hardware Keystore
              </div>
              <p>
                Inside the Android app (<span className="font-mono">app/</span>), assets are served via <span className="font-mono">WebViewAssetLoader</span> over <span className="font-mono">https://appassets.androidplatform.net</span> with <span className="font-mono">android:allowBackup=&quot;false&quot;</span>. Sensitive native credentials on Android should use <span className="font-mono">EncryptedSharedPreferences</span> backed by the hardware <span className="font-mono">AndroidKeyStore</span> (<span className="font-mono">MasterKey.KeyScheme.AES256_GCM</span>), which is cryptographically isolated from WebView <span className="font-mono">localStorage</span>.
              </p>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-6 flex flex-col justify-between space-y-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Data Lifecycle & Reset Controls
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Wipe all local IndexedDB tables or restore the 6-month multi-account sample dataset.
            </p>
          </div>

          <div className="space-y-2.5">
            <button
              type="button"
              onClick={onReseedDemoData}
              className="w-full px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset & Seed Sample Dataset
            </button>

            {!confirmClear ? (
              <button
                type="button"
                onClick={() => setConfirmClear(true)}
                className="w-full px-4 py-2 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Clear All Local Data
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onClearAllData();
                    setConfirmClear(false);
                  }}
                  className="flex-1 px-3 py-2 text-xs font-medium text-white bg-rose-700 hover:bg-rose-800 rounded-lg transition-colors"
                >
                  Confirm Wipe
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClear(false)}
                  className="px-3 py-2 text-xs font-medium text-slate-600 bg-slate-100 rounded-lg"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
