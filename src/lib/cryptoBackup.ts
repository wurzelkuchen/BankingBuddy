import {
  AppSettings,
  BankAccount,
  EncryptedBackupEnvelope,
  MerchantRule,
  TransactionRecord,
} from './types';

export interface PlainBackupPayload {
  version: number;
  exportedAt: string;
  accounts: BankAccount[];
  transactions: TransactionRecord[];
  rules: MerchantRule[];
  settings?: AppSettings;
}

const PBKDF2_ITERATIONS = 100_000;

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesGcmKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts full local IndexedDB snapshot using PBKDF2-SHA256 + AES-256-GCM.
 */
export async function createEncryptedBackup(
  payload: PlainBackupPayload,
  passphrase: string
): Promise<EncryptedBackupEnvelope> {
  if (!passphrase || passphrase.length < 4) {
    throw new Error('Backup passphrase must be at least 4 characters long.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveAesGcmKey(passphrase, salt);

  const encodedPlaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    encodedPlaintext
  );

  return {
    format: 'bankingBuddy-encrypted-v2',
    createdAt: new Date().toISOString(),
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM',
    saltBase64: uint8ToBase64(salt),
    ivBase64: uint8ToBase64(iv),
    ciphertextBase64: uint8ToBase64(new Uint8Array(ciphertextBuffer)),
  };
}

/**
 * Decrypts and validates an EncryptedBackupEnvelope using the user's passphrase.
 */
export async function decryptBackupEnvelope(
  envelope: EncryptedBackupEnvelope,
  passphrase: string
): Promise<PlainBackupPayload> {
  if (envelope.format !== 'bankingBuddy-encrypted-v2') {
    throw new Error('Unsupported backup envelope format.');
  }

  const salt = base64ToUint8(envelope.saltBase64);
  const iv = base64ToUint8(envelope.ivBase64);
  const ciphertext = base64ToUint8(envelope.ciphertextBase64);

  const key = await deriveAesGcmKey(passphrase, salt);

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    const jsonStr = new TextDecoder().decode(decryptedBuffer);
    const parsed = JSON.parse(jsonStr) as PlainBackupPayload;
    if (!Array.isArray(parsed.transactions) || !Array.isArray(parsed.accounts)) {
      throw new Error('Decrypted backup payload is missing required tables.');
    }
    return parsed;
  } catch {
    throw new Error('Decryption failed: Invalid passphrase or corrupted backup file.');
  }
}
